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

import fetch from "node-fetch";
import env from "../config/env.js";
import logger from "../config/logger.js";

const MQTT_URL = env.mqtt.internalUrl;
const API_KEY = env.mqtt.internalSecret;

// ─────────────────────────────────────────────
// _post – internal helper with retries
// ─────────────────────────────────────────────
async function _post(
  endpoint: string,
  body: Record<string, unknown>,
  retries = 3
): Promise<void> {
  const url = `${MQTT_URL}${endpoint}`;
  const log = logger.child({ url, body });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify(body),
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
export async function enqueueBroadcast(command: string): Promise<void> {
  await _post("/internal/broadcast", { command });
  logger.debug({ command }, "mqtt_bridge.broadcast_sent");
}

// ─────────────────────────────────────────────
// enqueueRoute
// Sends a command to a specific terminal.
// ─────────────────────────────────────────────
export async function enqueueRoute(
  terminalId: string,
  command: string
): Promise<void> {
  await _post(`/internal/route/${terminalId}`, { command });
  logger.debug({ terminalId, command }, "mqtt_bridge.route_sent");
}
