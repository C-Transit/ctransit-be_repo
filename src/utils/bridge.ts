// HTTP bridge from the main API to the MQTT microservice (X-API-Key auth).
import { randomUUID } from "crypto";
import fetch from "node-fetch";
import env from "../config/env.js";
import logger from "../config/logger.js";

const TIMEOUT_MS = 15_000;

export interface BroadcastResult {
  success: boolean;
  partial?: boolean;
  totalTerminals?: number;
  deliveredCount?: number;
  failedCount?: number;
  delivered?: string[] | number;
  failed?: string[] | number;
  failedTerminals?: string[];
  failures?: Array<{ terminalId: string; error?: string }> | string[];
  message?: string;
  [key: string]: unknown;
}

export function detectPartialBroadcastFailure(
  result: BroadcastResult | null | undefined
): {
  isPartial: boolean;
  failedCount: number;
  deliveredCount?: number;
  failedTerminals: string[];
} {
  if (!result) {
    return { isPartial: false, failedCount: 0, failedTerminals: [] };
  }

  const failedTerminals: string[] = [];
  if (Array.isArray(result.failedTerminals)) {
    failedTerminals.push(...result.failedTerminals);
  } else if (Array.isArray(result.failed)) {
    failedTerminals.push(...result.failed.map(String));
  } else if (Array.isArray(result.failures)) {
    for (const f of result.failures) {
      if (typeof f === "string") {
        failedTerminals.push(f);
      } else if (f && typeof f === "object" && "terminalId" in f) {
        failedTerminals.push(
          String((f as { terminalId: string | number }).terminalId)
        );
      }
    }
  }

  const failedCount =
    typeof result.failedCount === "number"
      ? result.failedCount
      : typeof result.failed === "number"
      ? result.failed
      : failedTerminals.length;

  const deliveredCount =
    typeof result.deliveredCount === "number"
      ? result.deliveredCount
      : typeof result.delivered === "number"
      ? result.delivered
      : Array.isArray(result.delivered)
      ? result.delivered.length
      : undefined;

  const isPartial =
    result.partial === true ||
    result.success === false ||
    failedCount > 0 ||
    failedTerminals.length > 0;

  return { isPartial, failedCount, deliveredCount, failedTerminals };
}

async function _post<T = Record<string, unknown>>(
  endpoint: string,
  body: Record<string, unknown>,
  commandId: string,
  retries = 3
): Promise<T> {
  const url = `${env.mqtt.internalUrl}${endpoint}`;
  const payload = { ...body, commandId };
  // Bind only url + commandId: payloads can contain PINs and card UIDs.
  const log = logger.child({ url, commandId });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": env.mqtt.internalSecret,
          "X-Command-Id": commandId,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok && res.status !== 207) {
        throw new Error(
          `MQTT service returned ${res.status}: ${await res.text()}`
        );
      }

      const data = (await res.json().catch(() => ({}))) as T;
      log.debug({ attempt, data }, "mqtt_bridge.http_success");
      return data;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, err: errMsg }, "mqtt_bridge.http_failed");
      if (attempt === retries) {
        log.error({ err: errMsg }, "mqtt_bridge.http_failed_all_retries");
        throw err;
      }
      // Backoff: 200ms, 400ms, 800ms
      await new Promise((resolve) =>
        setTimeout(resolve, 200 * 2 ** (attempt - 1))
      );
    }
  }
  throw new Error("HTTP bridge request failed after retries");
}

// Send a command to all online terminals.
export function enqueueBroadcast(
  command: string,
  commandId?: string
): Promise<BroadcastResult> {
  return _post<BroadcastResult>(
    "/internal/broadcast",
    { command },
    commandId || randomUUID()
  );
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
