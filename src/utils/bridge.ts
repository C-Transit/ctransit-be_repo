// HTTP bridge from the main API to the MQTT microservice (X-API-Key auth).
import { randomUUID } from "crypto";
import env from "../config/env.js";
import logger from "../config/logger.js";

const TIMEOUT_MS = 15_000;

export interface BroadcastResult {
  success: boolean;
  command?: string;
  totalTerminals?: number;
  deliveredCount?: number; // published straight to the terminal
  queuedCount?: number; // stored in Redis, delivered on reconnect
  failedTerminals?: string[]; // neither published nor queued
}

type BridgeError = Error & { retryable?: boolean };

async function _post<T = Record<string, unknown>>(
  endpoint: string,
  body: Record<string, unknown>,
  commandId: string,
  retries = 3
): Promise<T> {
  const url = `${env.mqtt.internalUrl}${endpoint}`;
  // Bind only url + commandId: payloads can contain PINs and card UIDs.
  const log = logger.child({ url, commandId });

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": env.mqtt.internalSecret,
          "X-Command-Id": commandId,
        },
        body: JSON.stringify({ ...body, commandId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok && res.status !== 207) {
        const err: BridgeError = new Error(
          `MQTT service returned ${res.status}: ${await res.text()}`
        );
        err.retryable = res.status >= 500;
        throw err;
      }

      return (await res.json().catch(() => ({}))) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, err: message }, "mqtt_bridge.http_failed");
      if (attempt >= retries || (err as BridgeError).retryable === false) {
        log.error({ err: message }, "mqtt_bridge.http_failed_final");
        throw err;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 200 * 2 ** (attempt - 1))
      );
    }
  }
}

// Send a command to all terminals (online ones directly, others via their Redis queue).
export async function enqueueBroadcast(
  command: string,
  commandId?: string
): Promise<BroadcastResult> {
  const id = commandId || randomUUID();
  const result = await _post<BroadcastResult>(
    "/internal/broadcast",
    { command },
    id
  );
  if (result.failedTerminals?.length) {
    logger.warn(
      { commandId: id, failedTerminals: result.failedTerminals },
      "mqtt_bridge.broadcast_partial"
    );
  }
  return result;
}

// Send a command to one terminal.
export function enqueueRoute(
  terminalId: string,
  command: string,
  commandId?: string
): Promise<Record<string, unknown>> {
  return _post(
    `/internal/route/${terminalId}`,
    { command },
    commandId || randomUUID()
  );
}

// Send whitelist chunks via the bulk endpoint, falling back to per-chunk broadcasts.
export async function enqueueSyncWhitelist(
  chunks: string[],
  syncId?: string
): Promise<void> {
  const id = syncId || randomUUID();
  try {
    await _post("/internal/sync/whitelist", { chunks, syncId: id }, id);
    logger.info(
      { syncId: id, chunkCount: chunks.length },
      "mqtt_bridge.sync_whitelist_job_sent"
    );
  } catch (err) {
    logger.warn(
      { err: String(err), syncId: id },
      "mqtt_bridge.sync_whitelist_fallback_to_broadcast"
    );
    for (let i = 0; i < chunks.length; i++) {
      await enqueueBroadcast(chunks[i], `${id}-chunk-${i}`);
    }
    await enqueueBroadcast("SYS:SYNC_COMPLETE", `${id}-complete`);
  }
}
