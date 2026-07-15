// src/config/redis.ts
import * as IORedisPkg from "ioredis";
import { type RedisOptions } from "ioredis";
import env from "./env.js";
import logger from "./logger.js";

const Redis = IORedisPkg.default;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRedisClient(): any {
  if (redisClient) return redisClient;

  const options: RedisOptions = {
    db: 0,
    retryStrategy(times: number): number | null {
      if (times > 10) {
        logger.error({ times }, "redis.max_retries_exceeded — stopping");
        return null;
      }
      const delay = Math.min(times * 200, 5000);
      logger.warn({ times, delayMs: delay }, "redis.reconnecting");
      return delay;
    },
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  };

  redisClient = new Redis(env.redis.url, options);

  (redisClient as IORedisPkg.Redis).on("connect", () =>
    logger.info("redis.connected")
  );
  (redisClient as IORedisPkg.Redis).on("ready", () =>
    logger.info("redis.ready")
  );
  (redisClient as IORedisPkg.Redis).on("error", (err: Error) =>
    logger.error({ err: err.message }, "redis.error")
  );
  (redisClient as IORedisPkg.Redis).on("close", () =>
    logger.warn("redis.connection_closed")
  );

  return redisClient;
}

// ── MQTT Bridge & Terminal Queue Keys ─────────────────────────────────────────
// These are the ONLY Redis keys used in the MQTT service.
// Wallet, blacklist, agent status, OTP, and refresh token
// caches have been removed — now handled by direct DB queries.
const redisKeys = {
  // Per-terminal downlink queue: RPUSH queue:term_01 "ADD:WL,uid"
  terminalQueue: (terminalId: string): string =>
    `queue:${terminalId.toLowerCase()}`,
};

const cacheKeys = {
  // Maps hardware card UID → student matricNumber
  // No TTL — permanent mapping, invalidated only on card re-link
  // This is the ONLY cache remaining in the MQTT service
  cardMap: (cardUid: string): string => `card:map:${cardUid}`,
};

export { getRedisClient, redisKeys, cacheKeys };
