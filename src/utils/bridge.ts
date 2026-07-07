// src/utils/bridge.ts
//
// Redis-based bridge from the main HTTP API to the MQTT microservice.
// Instead of calling broadcastDeltaToFleet() or routeDeltaToTerminal()
// directly (which requires an MQTT connection), the main API pushes
// commands to Redis queues that the MQTT service consumes.
//
// Queue keys:
//   mqtt:broadcast          → broadcastDeltaToFleet(command)
//   mqtt:route:{terminalId} → routeDeltaToTerminal(terminalId, command)
//
// The MQTT service's broadcast.consumer.ts drains these queues
// every 500ms and executes the actual MQTT publish.

import { getRedisClient } from "../config/redis.js";
import logger from "../config/logger.js";

const BROADCAST_QUEUE = "mqtt:broadcast";
const ROUTE_QUEUE_PREFIX = "mqtt:route:";

// ─────────────────────────────────────────────
// enqueueBroadcast
// Replaces broadcastDeltaToFleet() in the main API.
// Pushes a command to the broadcast queue —
// the MQTT service picks it up and fans it out
// to all online terminals.
// ─────────────────────────────────────────────
export async function enqueueBroadcast(command: string): Promise<void> {
  const redis = getRedisClient();
  await redis.rpush(BROADCAST_QUEUE, command);
  logger.debug({ command }, "mqtt_bridge.broadcast_enqueued");
}

// ─────────────────────────────────────────────
// enqueueRoute
// Replaces routeDeltaToTerminal() in the main API.
// Pushes a command to a per-terminal queue —
// the MQTT service picks it up and delivers it
// to the specific terminal (or queues it if offline).
// ─────────────────────────────────────────────
export async function enqueueRoute(
  terminalId: string,
  command: string
): Promise<void> {
  const redis = getRedisClient();
  await redis.rpush(
    `${ROUTE_QUEUE_PREFIX}${terminalId.toLowerCase()}`,
    command
  );
  logger.debug({ terminalId, command }, "mqtt_bridge.route_enqueued");
}
