import { Redis } from "ioredis";
import logger from "./logger.js";
import env from "./env.js";

// These are important information for future purposes
// lazyConnect: server.ts connects explicitly at boot so a bad URL fails there.
// enableOfflineQueue: false makes commands fail fast while Redis is down instead of queueing, so the health monitor in server.ts can see the outage.

export const redis = new Redis(env.redis.url, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

redis.on("error", (error) => {
  logger.error({ err: error.message }, "redis.connection_error");
});

const getRedisClient = (): Redis => redis;

const redisKeys = {
  linkOtp: (otp: string | number): string => `link_otp:${otp}`,
  terminalQueue: (terminalId: string): string =>
    `queue:${terminalId.toLowerCase()}`,
};

const cacheKeys = {
  cardMap: (cardUid: string): string => `card:map:${cardUid}`,
  webhookDedup: (reference: string): string => `webhook:dedupe:${reference}`,
  settlementDedup: (reference: string): string =>
    `settlement:dedupe:${reference}`,
  wallet: (matricNumber: string): string => `wallet:${matricNumber}`,
  blacklist: (matricNumber: string): string => `blacklist:${matricNumber}`,
  agentStatus: (agentId: string): string => `agent:status:${agentId}`,
  refreshToken: (tokenId: string): string => `refresh:${tokenId}`,
  terminalSecret: (terminalId: string): string =>
    `terminal:secret:${terminalId}`,
};

const AGENT_STATUS_TTL = 60;
const WEBHOOK_DEDUPE_TTL = 24 * 60 * 60;

export {
  getRedisClient,
  redisKeys,
  cacheKeys,
  AGENT_STATUS_TTL,
  WEBHOOK_DEDUPE_TTL,
};