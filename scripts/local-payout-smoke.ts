import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { KoraProvider } from "../src/payments/provider.ts";

type Captured = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
};

const captured: Captured[] = [];
const proxySecret = "local-smoke-proxy-secret";
const koraSecret = "local-smoke-kora-secret";

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const body = req.method === "POST" ? await readBody(req) : null;
  captured.push({
    method: req.method || "",
    path: url.pathname,
    headers: req.headers,
    body,
  });

  const send = (statusCode: number, payload: unknown) => {
    const raw = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(raw),
    });
    res.end(raw);
  };

  if (req.method === "POST" && url.pathname === "/disburse") {
    const reference = String(body?.reference || "");
    if (reference.includes("FAIL")) {
      return send(401, {
        status: false,
        message: "Please whitelist your IP Address to continue",
      });
    }
    if (reference.includes("5XX")) {
      return send(500, { status: false, message: "upstream error" });
    }
    return send(200, {
      status: true,
      message: "Payout initiated",
      data: {
        reference: "KORA-REF-SMOKE-1",
        status: "success",
        fee: 15,
      },
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/verify/")) {
    const reference = decodeURIComponent(url.pathname.slice("/verify/".length));
    if (reference.includes("MISSING")) {
      return send(404, { status: false, message: "Transaction not found" });
    }
    if (reference.includes("PROC")) {
      return send(200, {
        status: true,
        data: { reference: "KORA-REF-SMOKE-2", status: "processing", fee: 10 },
      });
    }
    return send(200, {
      status: true,
      data: {
        reference: "KORA-REF-SMOKE-3",
        status: "success",
        amount: 960,
        fee: 15,
      },
    });
  }

  return send(404, { status: false, message: "not found" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

const provider = new KoraProvider(koraSecret, "local-smoke-public-key", "http://127.0.0.1:9", {
  payoutWebhookUrl: "https://example.test/api/payments/payout-webhook",
  payoutProxyUrl: `http://127.0.0.1:${port}`,
  payoutProxySecret: proxySecret,
});

try {
  // 1. Happy path: backend -> proxy /disburse with the expected payload and secret.
  const ok = await provider.initiatePayout({
    reference: "WDR-LOCAL-SMOKE-1",
    amount: 960,
    destination: {
      type: "bank_account",
      amount: 960,
      currency: "NGN",
      narration: "C-Transit Driver Payout WDR-LOCAL-SMOKE-1",
      bank_account: { bank: "50515", account: "9045955670" },
    },
    customer: {
      name: "DESTINY IRIPIA EMIALA",
      email: "driver@example.test",
    },
  });

  const disburse = captured.find(
    (r) => r.method === "POST" && r.path === "/disburse"
  );
  assert.ok(disburse, "proxy /disburse was not called");
  assert.equal(disburse!.headers["x-payout-proxy-secret"], proxySecret);
  assert.equal(disburse!.headers.authorization, undefined);
  assert.equal(disburse!.body.reference, "WDR-LOCAL-SMOKE-1");
  assert.equal(disburse!.body.destination.amount, 960);
  assert.equal(disburse!.body.destination.currency, "NGN");
  assert.equal(disburse!.body.destination.bank_account.bank, "50515");
  assert.equal(disburse!.body.destination.bank_account.account, "9045955670");
  assert.equal(disburse!.body.destination.customer.name, "DESTINY IRIPIA EMIALA");
  assert.equal(
    disburse!.body.notification_url,
    "https://example.test/api/payments/payout-webhook"
  );
  assert.equal(ok.status, "success");
  assert.equal(ok.koraReference, "KORA-REF-SMOKE-1");
  assert.equal(ok.fee, 15);
  console.log("PASS initiatePayout happy path (payload, proxy secret, webhook URL)");

  // 2. Kora rejects with the whitelist error: must return failed, not throw.
  const rejected = await provider.initiatePayout({
    reference: "WDR-LOCAL-SMOKE-FAIL",
    amount: 960,
    destination: {
      type: "bank_account",
      amount: 960,
      currency: "NGN",
      bank_account: { bank: "50515", account: "9045955670" },
    },
    customer: { name: "DESTINY IRIPIA EMIALA", email: "driver@example.test" },
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.status, "failed");
  assert.match(rejected.message || "", /whitelist/i);
  console.log("PASS initiatePayout whitelist rejection is surfaced as failed");

  // 3. Verify success mapping.
  const verified = await provider.verifyPayout("WDR-LOCAL-SMOKE-1");
  assert.equal(verified.status, "success");
  assert.equal(verified.koraReference, "KORA-REF-SMOKE-3");
  assert.equal(verified.fee, 15);
  console.log("PASS verifyPayout success mapping");

  // 4. Verify processing mapping.
  const processing = await provider.verifyPayout("WDR-LOCAL-SMOKE-PROC");
  assert.equal(processing.status, "processing");
  assert.equal(processing.fee, 10);
  console.log("PASS verifyPayout processing mapping");

  // 5. Verify 404 -> not_found.
  const missing = await provider.verifyPayout("WDR-LOCAL-SMOKE-MISSING");
  assert.equal(missing.status, "not_found");
  console.log("PASS verifyPayout 404 -> not_found");

  // 6. 5xx on disburse must verify before deciding.
  const ambiguous = await provider.initiatePayout({
    reference: "WDR-LOCAL-SMOKE-5XX",
    amount: 960,
    destination: {
      type: "bank_account",
      amount: 960,
      currency: "NGN",
      bank_account: { bank: "50515", account: "9045955670" },
    },
    customer: { name: "DESTINY IRIPIA EMIALA", email: "driver@example.test" },
  });
  assert.equal(ambiguous.status, "success");
  assert.ok(
    captured.some(
      (r) => r.method === "GET" && r.path === "/verify/WDR-LOCAL-SMOKE-5XX"
    ),
    "5xx did not trigger a verify request"
  );
  console.log("PASS 5xx disburse verifies before deciding");

  // 7. Webhook signature uses the Kora secret over JSON.stringify(data) only.
  const data = {
    reference: "WDR-LOCAL-SMOKE-1",
    status: "success",
    amount: 960,
    currency: "NGN",
    fee: 15,
  };
  const signature = crypto
    .createHmac("sha256", koraSecret)
    .update(JSON.stringify(data))
    .digest("hex");
  assert.equal(provider.verifyWebhook(JSON.stringify(data), signature), true);
  assert.equal(
    provider.verifyWebhook(JSON.stringify({ ...data, amount: 961 }), signature),
    false
  );
  console.log("PASS webhook signature verification");

  console.log("\nALL LOCAL PAYOUT SMOKE TESTS PASSED");
} finally {
  server.close();
}
