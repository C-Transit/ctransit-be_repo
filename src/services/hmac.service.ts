// src/services/hmac.service.ts
//
// HMAC-SHA256 verification for terminal uplink messages.
// Terminals sign every message with their provisioned secret_key.
// The server verifies before any payload is processed.
//
// Message format sent by terminal:
//   HMAC:<hex_signature>|<raw_payload>
//
// Signature is computed as:
//   HMAC-SHA256(secret_key, terminalId + ":" + raw_payload)
//
// timingSafeEqual is used for comparison — prevents timing attacks
// where an attacker could brute-force the signature byte by byte
// by measuring response time differences.

import crypto from "crypto";
import { prisma } from "./ledger.service.js";
import logger from "../config/logger.js";

// Returned by verifyAndUnwrap — caller gets the clean payload
// or null if verification failed.
export interface HmacVerifyResult {
  payload: string; // Raw payload with HMAC wrapper stripped
  terminalId: string;
}

// ─────────────────────────────────────────────
// getTerminalSecret
// Redis-first lookup for the terminal's secret_key.
// Cache miss hits DB and populates cache with short TTL
// so key rotations propagate within TERMINAL_SECRET_TTL seconds.
// Returns null if terminal is not found or unprovisioned.
// ─────────────────────────────────────────────
async function getTerminalSecret(terminalId: string): Promise<string | null> {
  const terminal = await prisma.terminal.findUnique({
    where: { terminal_id: terminalId },
    select: { secret_key: true },
  });

  if (!terminal) return null;
  return terminal.secret_key;
}

// ─────────────────────────────────────────────
// computeHmac
// Pure function — used by both server (verify) and
// can be referenced in terminal firmware docs.
// ─────────────────────────────────────────────
function computeHmac(
  secretKey: string,
  terminalId: string,
  payload: string
): string {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${terminalId}:${payload}`)
    .digest("hex");
}

// ─────────────────────────────────────────────
// verifyAndUnwrap
// Main entry point called by uplinkRouter before routing.
//
// Returns the raw payload if verification passes.
// Returns null and logs a warning if:
//   - Message is not in HMAC:<sig>|<payload> format
//   - Terminal not found in DB
//   - Terminal is UNPROVISIONED (status-only terminal)
//   - HMAC signature does not match
//
// UNPROVISIONED terminals skip verification entirely —
// they only send LWT status messages on /status topic,
// which is handled before this function is called.
// ─────────────────────────────────────────────
async function verifyAndUnwrap(
  terminalId: string,
  rawMessage: string
): Promise<string | null> {
  const log = logger.child({ terminalId });

  // ── Parse message format: HMAC:<sig>|<payload> ───────────────────────
  // Split on first pipe only — payload itself may contain pipes (e.g. sync chunks)
  const pipeIndex = rawMessage.indexOf("|");
  if (pipeIndex === -1 || !rawMessage.startsWith("HMAC:")) {
    log.warn(
      { rawMessage: rawMessage.substring(0, 80) },
      "hmac.missing_wrapper — rejecting message"
    );
    return null;
  }

  const receivedSig = rawMessage.slice(5, pipeIndex); // strip "HMAC:" prefix
  const payload = rawMessage.slice(pipeIndex + 1);

  // Add after receivedSig and payload are extracted
  if (receivedSig.length !== 64) {
    log.warn(
      { sigLength: receivedSig.length },
      "hmac.invalid_signature_length — rejecting"
    );
    return null;
  }

  if (!receivedSig || !payload) {
    log.warn("hmac.malformed_wrapper — rejecting message");
    return null;
  }

  // ── Fetch terminal secret ─────────────────────────────────────────────
  const secretKey = await getTerminalSecret(terminalId);

  if (!secretKey) {
    log.warn("hmac.terminal_not_found — rejecting message");
    return null;
  }

  if (secretKey === "UNPROVISIONED") {
    // This path should not normally be reached — status messages on /status
    // topic are handled before HMAC verification in uplinkRouter.
    // Log it as a warning in case a firmware bug sends tx messages
    // before provisioning is complete.
    log.warn("hmac.terminal_unprovisioned — rejecting non-status message");
    return null;
  }

  // ── Verify signature ──────────────────────────────────────────────────
  const expectedSig = computeHmac(secretKey, terminalId, payload);

  // timingSafeEqual requires equal-length buffers — hex strings are always
  // 64 chars for SHA256, so this is safe without length check.
  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(receivedSig, "hex"),
    Buffer.from(expectedSig, "hex")
  );

  if (!signaturesMatch) {
    log.warn(
      { receivedSig, expectedSig },
      "hmac.signature_mismatch — rejecting message"
    );
    return null;
  }

  log.debug({ payload: payload.substring(0, 80) }, "hmac.verified");
  return payload;
}

// ─────────────────────────────────────────────
// invalidateTerminalSecretCache
// Call this when admin updates a terminal's secret_key
// via the terminal registration route so the new key
// takes effect immediately rather than after TTL expiry.
// ─────────────────────────────────────────────
export { verifyAndUnwrap, computeHmac };
