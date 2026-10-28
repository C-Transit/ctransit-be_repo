import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY?.trim();
const PAYOUT_PROXY_SECRET = process.env.PAYOUT_PROXY_SECRET?.trim();
const KORA_BASE_URL = (
  process.env.KORA_BASE_URL || "https://api.korapay.com/merchant"
).replace(/\/+$/, "");
const DRY_RUN = process.env.PAYOUT_PROXY_DRY_RUN === "true";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_KORA_RESPONSE_BYTES = 1024 * 1024;
const KORA_TIMEOUT_MS = 30_000;

if (!KORA_BASE_URL.startsWith("https://")) {
  console.error("FATAL: KORA_BASE_URL must start with https://");
  process.exit(1);
}

if (!PAYOUT_PROXY_SECRET) {
  console.error("FATAL: PAYOUT_PROXY_SECRET is required");
  process.exit(1);
}

if (PAYOUT_PROXY_SECRET.length < 32) {
  console.error("FATAL: PAYOUT_PROXY_SECRET must be at least 32 characters");
  process.exit(1);
}

if (!KORA_SECRET_KEY && !DRY_RUN) {
  console.error(
    "FATAL: KORA_SECRET_KEY is required unless PAYOUT_PROXY_DRY_RUN=true"
  );
  process.exit(1);
}

if (DRY_RUN) {
  console.warn(
    "WARNING: PAYOUT_PROXY_DRY_RUN=true — no real Kora payout will be sent"
  );
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(
    body ?? { status: false, message: "Empty response" }
  );
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        tooLarge = true;
        reject(
          Object.assign(new Error("Request body too large"), {
            statusCode: 413,
          })
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (tooLarge) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        reject(
          Object.assign(new Error("Invalid JSON body"), { statusCode: 400 })
        );
      }
    });

    req.on("error", reject);
  });
}

function safeEqual(leftValue, rightValue) {
  if (typeof leftValue !== "string" || typeof rightValue !== "string") {
    return false;
  }
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireProxySecret(req, res) {
  const supplied = req.headers["x-payout-proxy-secret"];
  if (
    typeof supplied !== "string" ||
    !safeEqual(supplied, PAYOUT_PROXY_SECRET)
  ) {
    sendJson(res, 401, {
      status: false,
      message: "Payout proxy unauthorized",
    });
    return false;
  }
  return true;
}

function forwardToKora({ method, path, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${KORA_BASE_URL}${path}`);
    const payload = body ? JSON.stringify(body) : null;

    const request = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        family: 4, // Force IPv4 so the Kora-whitelisted address is deterministic.
        timeout: KORA_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${KORA_SECRET_KEY}`,
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;

        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_KORA_RESPONSE_BYTES) {
            response.destroy(new Error("Kora response too large"));
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ statusCode: response.statusCode || 502, body: parsed });
        });

        response.on("error", reject);
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Kora request timed out"));
    });
    request.on("error", reject);

    if (payload) request.write(payload);
    request.end();
  });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validatePayout(body) {
  if (!body || typeof body !== "object") return "Missing payout body";
  if (!isNonEmptyString(body.reference)) return "Missing reference";
  if (body.reference.length > 100) return "Reference is too long";

  const destination = body.destination;
  if (!destination || typeof destination !== "object") {
    return "Missing destination";
  }
  if (destination.type !== "bank_account") {
    return "Unsupported destination type";
  }

  const amount = Number(destination.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "Invalid amount";
  if (!isNonEmptyString(destination.currency)) return "Missing currency";

  const bankAccount = destination.bank_account;
  if (!bankAccount || typeof bankAccount !== "object") {
    return "Missing bank_account";
  }
  if (!isNonEmptyString(bankAccount.bank)) return "Missing bank code";
  if (!isNonEmptyString(bankAccount.account)) return "Missing account number";

  return null;
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      ok: true,
      dryRun: DRY_RUN,
      koraConfigured: Boolean(KORA_SECRET_KEY),
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  if (req.method === "POST" && path === "/disburse") {
    if (!requireProxySecret(req, res)) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.statusCode || 400, {
        status: false,
        message: err.message,
      });
    }

    const validationError = validatePayout(body);
    if (validationError) {
      return sendJson(res, 400, {
        status: false,
        message: validationError,
      });
    }

    if (DRY_RUN) {
      console.log(
        JSON.stringify({
          event: "payout_proxy.disburse",
          dryRun: true,
          reference: body.reference,
          durationMs: Date.now() - startedAt,
        })
      );
      return sendJson(res, 200, {
        status: true,
        message: "Dry run accepted",
        data: {
          reference: body.reference,
          status: "processing",
          amount: body.destination.amount,
          currency: body.destination.currency,
        },
      });
    }

    try {
      const koraResponse = await forwardToKora({
        method: "POST",
        path: "/api/v1/transactions/disburse",
        body,
      });
      console.log(
        JSON.stringify({
          event: "payout_proxy.disburse",
          reference: body.reference,
          statusCode: koraResponse.statusCode,
          durationMs: Date.now() - startedAt,
        })
      );
      return sendJson(res, koraResponse.statusCode, koraResponse.body);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "payout_proxy.disburse_error",
          reference: body.reference,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        })
      );
      return sendJson(res, 504, {
        status: false,
        message: "Kora payout request timed out or failed",
      });
    }
  }

  if (req.method === "GET" && path.startsWith("/verify/")) {
    if (!requireProxySecret(req, res)) return;

    const reference = decodeURIComponent(path.slice("/verify/".length));
    if (!reference || reference.length > 100) {
      return sendJson(res, 400, {
        status: false,
        message: "Invalid reference",
      });
    }

    if (DRY_RUN) {
      return sendJson(res, 200, {
        status: true,
        message: "Dry run verify",
        data: { reference, status: "processing" },
      });
    }

    try {
      const koraResponse = await forwardToKora({
        method: "GET",
        path: `/api/v1/transactions/${encodeURIComponent(reference)}`,
      });
      console.log(
        JSON.stringify({
          event: "payout_proxy.verify",
          reference,
          statusCode: koraResponse.statusCode,
          durationMs: Date.now() - startedAt,
        })
      );
      return sendJson(res, koraResponse.statusCode, koraResponse.body);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "payout_proxy.verify_error",
          reference,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        })
      );
      return sendJson(res, 504, {
        status: false,
        message: "Kora verify request timed out or failed",
      });
    }
  }

  return sendJson(res, 404, { status: false, message: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "payout_proxy.started",
      port: PORT,
      dryRun: DRY_RUN,
      koraBaseUrl: KORA_BASE_URL,
    })
  );
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: "payout_proxy.shutdown", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
