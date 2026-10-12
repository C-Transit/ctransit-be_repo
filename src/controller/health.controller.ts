import { Router } from "express";
import { getRedisClient } from "../config/redis.js";
import { prisma } from "../lib/prisma.js";
import logger from "../config/logger.js";

const router = Router();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");

// Public liveness/readiness check. Details go to the logs, not the response.
router.get("/", async (_req, res) => {
  const [postgres, redis] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    getRedisClient().ping(),
  ]);

  if (postgres.status === "rejected") logger.error({ err: errMsg(postgres.reason) }, "health.postgres_check_failed");
  if (redis.status === "rejected") logger.error({ err: errMsg(redis.reason) }, "health.redis_check_failed");

  const healthy = postgres.status === "fulfilled" && redis.status === "fulfilled";
  res.status(healthy ? 200 : 503).json({ status: healthy ? "healthy" : "degraded", timestamp: new Date().toISOString() });
});

export default router;