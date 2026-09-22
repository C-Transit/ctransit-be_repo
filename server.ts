"use strict";

// Validate and load environment variables
import "./src/config/env.js";

import http from "http";
import app from "./app.js";
import { getRedisClient } from "./src/config/redis.js";
import { prisma } from "./src/services/ledger.service.js";
import logger from "./src/config/logger.js";
import env from "./src/config/env.js";

// HTTP server with boot/shutdown sequence for Redis, PostgreSQL, and MQTT
const server = http.createServer(app);
let isShuttingDown = false;
let databaseMonitor: NodeJS.Timeout | undefined;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after 15 seconds`));
    }, 15_000);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function boot(): Promise<void> {
  logger.info(
    { version: process.version, env: env.NODE_ENV },
    "server.boot_start"
  );

  try {
    const redis = getRedisClient() as {
      connect: () => Promise<unknown>;
      ping: () => Promise<string>;
    };
    await withTimeout(redis.connect(), "Redis connection");
    await withTimeout(redis.ping(), "Redis health check");
    logger.info("server.redis_ready");
    logger.info("server.postgres_connecting");
    await withTimeout(prisma.$connect(), "PostgreSQL connection");
    await withTimeout(prisma.$queryRaw`SELECT 1`, "PostgreSQL health check");
    logger.info(
      { database: "postgresql" },
      "server.postgres_connection_established"
    );
  } catch (err) {
    logger.fatal(
      { err: formatError(err) },
      "server.boot_failed — critical dependency unavailable"
    );
    await shutdown("boot_failure", 1);
    return;
  }

  server.on("error", (err: Error) => {
    logger.fatal({ err: err.message }, "server.http_error");
    void shutdown("http_error", 1);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(env.PORT, () => {
      logger.info({ port: env.PORT }, "server.http_listening");
      resolve();
    });
    server.once("error", reject);
  }).catch(async (err: unknown) => {
    logger.fatal({ err: formatError(err) }, "server.boot_failed — HTTP server unavailable");
    await shutdown("http_boot_failure", 1);
  });

  if (!server.listening) return;

  databaseMonitor = setInterval(() => {
    void Promise.all([
      prisma.$queryRaw`SELECT 1`,
      (getRedisClient() as { ping: () => Promise<string> }).ping(),
    ]).catch(async (err: unknown) => {
      logger.fatal(
        { err: formatError(err) },
        "server.critical_dependency_connection_lost — shutting down"
      );
      await shutdown("critical_dependency_connection_lost", 1);
    });
  }, 15_000);

  logger.info("server.boot_complete — all systems operational");
}

// Graceful shutdown handler
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "server.shutdown_initiated");

  if (databaseMonitor) {
    clearInterval(databaseMonitor);
    databaseMonitor = undefined;
  }

  if (server.listening) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        logger.info("server.http_closed");
        resolve();
      });
    });
  }

  try {
    const redis = getRedisClient() as { quit: () => Promise<unknown> };
    await redis.quit();
    logger.info("server.redis_disconnected");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg }, "server.redis_disconnect_error");
  }

  try {
    await prisma.$disconnect();
    logger.info("server.postgres_disconnected");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg }, "server.postgres_disconnect_error");
  }

  logger.info("server.shutdown_complete");
  process.exit(exitCode);
}

// Handle termination signals and unhandled errors
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on(
  "unhandledRejection",
  (reason: unknown, promise: Promise<unknown>) => {
    logger.fatal(
      { reason: String(reason), promise: String(promise) },
      "server.unhandled_promise_rejection"
    );
    void shutdown("unhandled_rejection", 1);
  }
);

process.on("uncaughtException", (err: Error) => {
  logger.fatal(
    { err: err.message, stack: err.stack },
    "server.uncaught_exception — shutting down safely"
  );
  shutdown("uncaughtException");
});

boot();
