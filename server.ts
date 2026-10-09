// server.ts
import env from "./src/config/env.js";
import http from "http";
import app from "./app.js";
import { getRedisClient } from "./src/config/redis.js";
import { prisma } from "./src/lib/prisma.js";
import logger from "./src/config/logger.js";

const TIMEOUT_MS = 15_000;
const server = http.createServer(app);
let isShuttingDown = false;
let databaseMonitor: NodeJS.Timeout;

const formatError = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

async function withTimeout<T>(
  operation: Promise<T>,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} connection timed out`)),
      TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout!);
  }
}

async function boot() {
  try {
    const redis = getRedisClient();
    await withTimeout(redis.ping(), "Redis");
    await withTimeout(prisma.$queryRaw`SELECT 1`, "PostgreSQL");
  } catch (err) {
    logger.fatal(
      { err: formatError(err), reason: "critical dependency unavailable" },
      "server.boot_failed"
    );
    return shutdown("boot_failure", 1);
  }

  server.on("error", (err: Error) => {
    logger.fatal({ err: err.message }, "server.http_error");
    shutdown("http_error", 1);
  });

  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, version: process.version, env: env.NODE_ENV },
      "server.boot_complete"
    );

    databaseMonitor = setInterval(() => {
      Promise.all([prisma.$queryRaw`SELECT 1`, getRedisClient().ping()]).catch(
        (err) => {
          logger.error(
            { err: formatError(err) },
            "server.dependency_connection_lost"
          );
        }
      );
    }, TIMEOUT_MS);
  });
}

async function shutdown(signal: string, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "server.shutdown_initiated");
  clearInterval(databaseMonitor);

  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const disconnects = await Promise.allSettled([
    getRedisClient().quit(),
    prisma.$disconnect(),
  ]);

  disconnects.forEach((result, index) => {
    if (result.status === "rejected") {
      const db = index === 0 ? "redis" : "postgres";
      logger.error(
        { err: formatError(result.reason) },
        `server.${db}_disconnect_error`
      );
    }
  });

  logger.info("server.shutdown_complete");
  process.exit(exitCode);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => shutdown(signal));
}

process.on("unhandledRejection", (reason: unknown) => {
  logger.fatal({ reason: String(reason) }, "server.unhandled_rejection");
  shutdown("unhandled_rejection", 1);
});

process.on("uncaughtException", (err: Error) => {
  logger.fatal(
    { err: err.message, stack: err.stack },
    "server.uncaught_exception"
  );
  shutdown("uncaught_exception", 1);
});

boot();
