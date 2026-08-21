// src/config/redis.ts
import * as IORedisPkg from "ioredis";
import { type RedisOptions } from "ioredis";
import env from "./env.js";
import logger from "./logger.js";

const Redis = IORedisPkg.default;

class InMemoryRedis {
  private store = new Map<string, { value: string; expiry?: number }>();
  private lists = new Map<string, string[]>();
  private eventHandlers = new Map<string, Array<() => void>>();

  on(event: string, handler: () => void) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)?.push(handler);
    if (event === "connect" || event === "ready") {
      setTimeout(() => handler(), 0);
    }
    return this;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiry && item.expiry < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string> {
    let expiry: number | undefined = undefined;
    if (args[0] === "EX" && typeof args[1] === "number") {
      expiry = Date.now() + args[1] * 1000;
    } else if (args[0] === "PX" && typeof args[1] === "number") {
      expiry = Date.now() + args[1];
    }
    this.store.set(key, { value, expiry });
    return "OK";
  }

  async setex(key: string, seconds: number, value: string): Promise<string> {
    this.store.set(key, { value, expiry: Date.now() + seconds * 1000 });
    return "OK";
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k) || this.lists.delete(k)) {
        count++;
      }
    }
    return count;
  }

  async incr(key: string): Promise<number> {
    const item = await this.get(key);
    const num = (item ? parseInt(item, 10) : 0) + 1;
    await this.set(key, String(num));
    return num;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) || [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) || [];
    const end = stop === -1 ? undefined : stop + 1;
    return list.slice(start, end);
  }

  async quit(): Promise<string> {
    return "OK";
  }

  async disconnect(): Promise<void> {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRedisClient(): any {
  if (redisClient) return redisClient;

  // Use in-memory Redis if configured or if no external Redis is active
  if (!process.env.REDIS_URL || process.env.REDIS_URL.includes("localhost")) {
    logger.info("redis.in_memory_mock_active");
    redisClient = new InMemoryRedis();
    return redisClient;
  }

  try {
    const options: RedisOptions = {
      db: 0,
      retryStrategy(times: number): number | null {
        if (times > 3) {
          logger.warn({ times }, "redis.max_retries_reached — falling back to memory");
          return null;
        }
        return Math.min(times * 100, 1000);
      },
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 2000,
    };

    // @ts-expect-error - ioredis has complex module exports
    redisClient = new Redis(env.redis.url, options);

    (redisClient as IORedisPkg.Redis).on("connect", () =>
      logger.info("redis.connected")
    );
    (redisClient as IORedisPkg.Redis).on("ready", () =>
      logger.info("redis.ready")
    );
    (redisClient as IORedisPkg.Redis).on("error", (err: Error) => {
      logger.warn({ err: err.message }, "redis.connection_error — using fallback");
    });
    (redisClient as IORedisPkg.Redis).on("close", () =>
      logger.warn("redis.connection_closed")
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "redis.init_failed — using memory fallback");
    redisClient = new InMemoryRedis();
  }

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
