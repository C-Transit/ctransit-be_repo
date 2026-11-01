import "dotenv/config";
import { createPayoutHttpClient } from "../src/lib/payoutHttp.js";

type SafeErrorDetails = {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  response?: { status?: unknown };
};

function getSafeFailure(error: unknown): { code: string; hint: string } {
  const details =
    error && typeof error === "object"
      ? (error as SafeErrorDetails)
      : {};
  const message = typeof details.message === "string" ? details.message : "";
  const responseStatus =
    typeof details.response?.status === "number"
      ? details.response.status
      : undefined;
  const tunnelStatus = message.match(/statusCode=(\d{3})\b/)?.[1];
  const status = responseStatus ?? (tunnelStatus ? Number(tunnelStatus) : undefined);

  if (message === "INVALID_PAYOUT_PROXY_URL") {
    return {
      code: "INVALID_PAYOUT_PROXY_URL",
      hint: "Check the proxy URL syntax and percent-encode special characters in credentials, especially the password.",
    };
  }
  if (status === 407) {
    return {
      code: "HTTP_407",
      hint: "Check proxy authentication; percent-encode special characters in the username and password.",
    };
  }
  if (status !== undefined) {
    return {
      code: `HTTP_${status}`,
      hint: "Check proxy availability and outbound connectivity.",
    };
  }

  const rawCode = typeof details.code === "string" ? details.code : "";
  const safeCode =
    /^(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|ERR_TUNNEL_CONNECTION_FAILED|ERR_(?:TLS|SSL)_[A-Z0-9_]+|CERT_[A-Z0-9_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/.test(
      rawCode
    )
      ? rawCode
      : undefined;

  if (safeCode === "ECONNREFUSED") {
    return { code: safeCode, hint: "Check the proxy host and port and confirm the proxy is accepting connections." };
  }
  if (safeCode === "ETIMEDOUT") {
    return { code: safeCode, hint: "Check proxy responsiveness and network/firewall rules." };
  }
  if (safeCode === "ENOTFOUND" || safeCode === "EAI_AGAIN") {
    return { code: safeCode, hint: "Check the proxy hostname and DNS resolution." };
  }
  if (safeCode?.startsWith("ERR_TLS_") || safeCode?.startsWith("ERR_SSL_") ||
      safeCode?.startsWith("CERT_") || safeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      safeCode === "DEPTH_ZERO_SELF_SIGNED_CERT" || safeCode === "SELF_SIGNED_CERT_IN_CHAIN") {
    return { code: safeCode, hint: "Check proxy TLS settings and certificate trust." };
  }
  if (safeCode) {
    return { code: safeCode, hint: "Check proxy availability and network connectivity." };
  }

  const errorClass =
    typeof details.name === "string" &&
    ["AxiosError", "TypeError", "Error", "RangeError", "URIError", "AggregateError"].includes(details.name)
      ? details.name
      : "UnknownError";
  return {
    code: errorClass,
    hint: "Check the proxy URL, credentials, and connectivity.",
  };
}

try {
  const response = await createPayoutHttpClient().get<string>(
    "https://api.ipify.org",
    { responseType: "text" }
  );
  const ip = response.data.trim();
  if (response.status < 200 || response.status >= 300 || !ip) {
    const error = new Error("PAYOUT_IP_CHECK_FAILED") as Error & {
      response?: { status: number };
    };
    error.response = { status: response.status };
    throw error;
  }
  process.stdout.write(`${ip}\n`);
} catch (error) {
  const { code, hint } = getSafeFailure(error);
  console.error(`Payout proxy check failed: ${code}.`);
  console.error(`Hint: ${hint}`);
  process.exitCode = 1;
}
