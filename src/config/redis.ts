// src/config/redis.ts
import { Redis } from "ioredis";
import logger from "./logger.js";
import env from "./env.js";

const isLiveLikeEnvironment =
  env.NODE_ENV === "production" || env.NODE_ENV === "staging";

const store = new Map<string, string | number>();
const lists = new Map<string, string[]>();

const memoryRedis = {
  connect: async (): Promise<void> => {
    logger.info("redis.mock_connected");
  },
  ping: async (): Promise<string> => "PONG",
  quit: async (): Promise<void> => {
    logger.info("redis.mock_quit");
  },
  disconnect: async (): Promise<void> => {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  on: (_event: string, _callback: (...args: unknown[]) => void) => memoryRedis,
  get: async (k: string): Promise<string | null> => {
    const val = store.get(k);
    return val !== undefined ? String(val) : null;
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  set: async (k: string, v: unknown, ..._args: unknown[]): Promise<string> => {
    store.set(k, String(v));
    return "OK";
  },
  setex: async (k: string, _ttl: number, v: unknown): Promise<string> => {
    store.set(k, String(v));
    return "OK";
  },
  del: async (k: string): Promise<number> => (store.delete(k) ? 1 : 0),
  incr: async (k: string): Promise<number> => {
    const n = (Number(store.get(k)) || 0) + 1;
    store.set(k, n);
    return n;
  },
  lpush: async (k: string, ...values: string[]): Promise<number> => {
    const list = lists.get(k) || [];
    list.unshift(...values);
    lists.set(k, list);
    return list.length;
  },
  rpush: async (k: string, ...values: string[]): Promise<number> => {
    const list = lists.get(k) || [];
    list.push(...values);
    lists.set(k, list);
    return list.length;
  },
  lpop: async (k: string): Promise<string | null> => {
    const list = lists.get(k) || [];
    const item = list.shift() ?? null;
    lists.set(k, list);
    return item;
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  expire: async (_k: string, _ttl: number): Promise<number> => 1,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ttl: async (_k: string): Promise<number> => 300,
};

const networkRedis = new Redis(env.redis.url, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

networkRedis.on("error", (error) => {
  logger.error({ err: error.message }, "redis.connection_error");
});

export const redis = isLiveLikeEnvironment ? networkRedis : memoryRedis;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRedisClient(): any {
  return redis;
}

// MQTT & OTP Keys 
const redisKeys = {
  linkOtp: (otp: string | number): string => `link_otp:${otp}`,
  terminalQueue: (terminalId: string): string =>
    `queue:${terminalId.toLowerCase()}`,
};

// Hot Read Cache Keys 
const cacheKeys = {
  cardMap: (cardUid: string): string => `card:map:${cardUid}`,
  webhookDedup: (reference: string): string => `webhook:dedupe:${reference}`,
  settlementDedup: (reference: string): string => `settlement:dedupe:${reference}`,
  wallet: (matricNumber: string): string => `wallet:${matricNumber}`,
  blacklist: (matricNumber: string): string => `blacklist:${matricNumber}`,
  agentStatus: (agentId: string): string => `agent:status:${agentId}`,
  refreshToken: (tokenId: string): string => `refresh:${tokenId}`,
  terminalSecret: (terminalId: string): string =>
    `terminal:secret:${terminalId}`,
};

// TTL Constants
const OTP_TTL_SECONDS = 300;
const WALLET_CACHE_TTL = 30;
const BLACKLIST_CACHE_TTL = 60;
const AGENT_STATUS_TTL = 60;
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60;
const TERMINAL_SECRET_TTL = 60;
const WEBHOOK_DEDUPE_TTL = 24 * 60 * 60;

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
  WEBHOOK_DEDUPE_TTL,
};
