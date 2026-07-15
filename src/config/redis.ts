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

  // @ts-expect-error - ioredis has complex module exports
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

// ── MQTT & OTP Keys ───────────────────────────────────────────────────────────
const redisKeys = {
  // Card registration OTP: SETEX link_otp:{otp} 300 "cardUid|terminalId"
  linkOtp: (otp: string | number): string => `link_otp:${otp}`,

  // Per-terminal downlink queue: RPUSH queue:term_01 "ADD:WL,uid"
  terminalQueue: (terminalId: string): string =>
    `queue:${terminalId.toLowerCase()}`,
};

// ── Hot Read Cache Keys ───────────────────────────────────────────────────────
const cacheKeys = {
  // Maps hardware card UID → student matricNumber
  // No TTL — permanent mapping, invalidated only on card re-link
  cardMap: (cardUid: string): string => `card:map:${cardUid}`,

  // Caches wallet { balance, is_linked } per student
  // Short TTL — balance changes on every tap
  wallet: (matricNumber: string): string => `wallet:${matricNumber}`,

  // Caches blacklist presence per student
  // Longer TTL — changes less frequently than balance
  blacklist: (matricNumber: string): string => `blacklist:${matricNumber}`,

  // Caches agent account status for middleware checks on every agent request
  // MUST be DEL'd immediately when admin changes agent status
  agentStatus: (agentId: string): string => `agent:status:${agentId}`,

  // Refresh token store — keyed by tokenId (UUID v4 generated at login)
  // Value: JSON { userId, role, email }
  // TTL: REFRESH_TOKEN_TTL (7 days)
  // DEL on logout or account deactivation — instant revocation
  refreshToken: (tokenId: string): string => `refresh:${tokenId}`,

  // Caches terminal secret_key for HMAC verification on every uplink message.
  // Short TTL — secret rotations propagate within 60s.
  // DEL this key when admin updates a terminal's secret_key.
  terminalSecret: (terminalId: string): string =>
    `terminal:secret:${terminalId}`,
};

// ── TTL Constants ─────────────────────────────────────────────────────────────
const OTP_TTL_SECONDS = 300; // Card registration OTP — 5 minutes
const WALLET_CACHE_TTL = 30; // seconds — short, balance changes every tap
const BLACKLIST_CACHE_TTL = 60; // seconds — longer, changes less frequently
const AGENT_STATUS_TTL = 60; // seconds — suspension propagates within 1 min
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const TERMINAL_SECRET_TTL = 60; // seconds — short enough for key rotation to propagate

export {
  getRedisClient,
  redisKeys,
  cacheKeys,
  OTP_TTL_SECONDS,
  WALLET_CACHE_TTL,
  BLACKLIST_CACHE_TTL,
  AGENT_STATUS_TTL,
  REFRESH_TOKEN_TTL,
  TERMINAL_SECRET_TTL,
};
