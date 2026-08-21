// src/utils/bridge.ts
//
// HTTP bridge from the main API to the MQTT microservice.
// All fleet/terminal commands are sent as HTTP requests to
// the MQTT service's internal endpoints.
//
// Endpoints:
//   POST /internal/broadcast  → broadcastDeltaToFleet(command)
//   POST /internal/route/:id  → routeDeltaToTerminal(id, command)
//
// Authentication: X-API-Key header with MQTT_INTERNAL_SECRET.

import { randomUUID } from "crypto";
import fetch from "node-fetch";
import env from "../config/env.js";
import logger from "../config/logger.js";

const MQTT_URL = env.mqtt.internalUrl;
const API_KEY = env.mqtt.internalSecret;

// ─────────────────────────────────────────────
// _post – internal helper with retries & idempotency
// ─────────────────────────────────────────────
async function _post(
  endpoint: string,
  body: Record<string, unknown>,
  commandId?: string,
  retries = 3
): Promise<void> {
  const url = `${MQTT_URL}${endpoint}`;
  const id = commandId || (body.commandId as string) || randomUUID();
  const payload = { ...body, commandId: id };
  const log = logger.child({ url, commandId: id, body: payload });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "X-Command-Id": id,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MQTT service returned ${res.status}: ${text}`);
      }

      log.debug({ attempt }, "mqtt_bridge.http_success");
      return;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, err: errMsg }, "mqtt_bridge.http_failed");
      if (attempt === retries) {
        log.error({ err: errMsg }, "mqtt_bridge.http_failed_all_retries");
        throw err;
      }
      // Exponential backoff: 200ms, 400ms, 800ms
      await new Promise((resolve) =>
        setTimeout(resolve, 200 * 2 ** (attempt - 1))
      );
    }
  }
}

// ─────────────────────────────────────────────
// enqueueBroadcast
// Sends a command to all online terminals.
// ─────────────────────────────────────────────
export async function enqueueBroadcast(
  command: string,
  commandId?: string
): Promise<void> {
  const id = commandId || randomUUID();
  await _post("/internal/broadcast", { command, commandId: id }, id);
  logger.debug({ commandId: id, command }, "mqtt_bridge.broadcast_sent");
}

// ─────────────────────────────────────────────
// enqueueRoute
// Sends a command to a specific terminal.
// ─────────────────────────────────────────────
export async function enqueueRoute(
  terminalId: string,
  command: string,
  commandId?: string
): Promise<void> {
  const id = commandId || randomUUID();
  await _post(`/internal/route/${terminalId}`, { command, commandId: id }, id);
  logger.debug({ terminalId, commandId: id, command }, "mqtt_bridge.route_sent");
}

// ─────────────────────────────────────────────
// enqueueSyncWhitelist
// Sends full whitelist sync chunks to fleet in batch
// ─────────────────────────────────────────────
export async function enqueueSyncWhitelist(
  chunks: string[],
  syncId?: string
): Promise<void> {
  const id = syncId || randomUUID();
  try {
    // Attempt single fleet-sync job endpoint on MQTT service
    await _post("/internal/sync/whitelist", { chunks, syncId: id }, id);
    logger.info({ syncId: id, chunkCount: chunks.length }, "mqtt_bridge.sync_whitelist_job_sent");
  } catch (err) {
    logger.warn(
      { err: String(err), syncId: id },
      "mqtt_bridge.sync_whitelist_fallback_to_broadcast"
    );
    // Resilient fallback: broadcast each chunk to the fleet
    for (let i = 0; i < chunks.length; i++) {
      await enqueueBroadcast(chunks[i], `${id}-chunk-${i}`);
    }
    await enqueueBroadcast("SYS:SYNC_COMPLETE", `${id}-complete`);
  }
}
