import { PrismaClient } from "@prisma/client";
import env from "../config/env.js";
import logger from "../config/logger.js";

const isLiveLikeEnvironment =
  env.NODE_ENV === "production" || env.NODE_ENV === "staging";

// In production/staging, use the pooled URL (pgBouncer-compatible).
// In development, use the direct URL so migrations and transactions work without
// pgBouncer's prepared-statement restrictions.
const databaseUrl = isLiveLikeEnvironment ? env.db.pooledUrl : env.db.url;

let realPrisma: PrismaClient | null = null;

try {
  realPrisma = new PrismaClient({
    log: isLiveLikeEnvironment ? ["error"] : ["warn", "error"],
    errorFormat: "minimal",
    datasources: { db: { url: databaseUrl } },
  });
} catch (err) {
  if (isLiveLikeEnvironment) {
    // In production we must have a real DB — surface the error immediately.
    throw err;
  }
  logger.warn({ err: String(err) }, "prisma.client_init_fallback");
}

// ─── In-memory mock (development only, when Postgres is unavailable) ──────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inMemoryStore: Record<string, Map<string, any>> = {};

function getStore(model: string) {
  if (!inMemoryStore[model]) {
    inMemoryStore[model] = new Map();
  }
  return inMemoryStore[model];
}

const createMockModel = (modelName: string) => {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    findMany: async (_args?: unknown) => {
      return Array.from(getStore(modelName).values());
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    findFirst: async (_args?: unknown) => {
      const records = Array.from(getStore(modelName).values());
      return records[0] ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: async (args?: any) => {
      const store = getStore(modelName);
      if (args?.where) {
        for (const item of store.values()) {
          let match = true;
          for (const key of Object.keys(args.where)) {
            if (item[key] !== args.where[key]) {
              match = false;
              break;
            }
          }
          if (match) return item;
        }
      }
      return null;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: async (args: any) => {
      const id =
        args?.data?.id ||
        args?.data?.matricNumber ||
        args?.data?.transaction_id ||
        `mock_${Date.now()}`;
      const record = {
        id,
        ...args?.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      getStore(modelName).set(id, record);
      return record;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: async (args: any) => {
      const id =
        args?.where?.id ||
        args?.where?.matricNumber ||
        args?.where?.transaction_id;
      const existing = id ? getStore(modelName).get(id) || {} : {};
      const updated = { ...existing, ...args?.data, updatedAt: new Date() };
      if (id) getStore(modelName).set(id, updated);
      return updated;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: async (args: any) => {
      const id = args?.where?.id || args?.where?.matricNumber;
      const existing = id ? getStore(modelName).get(id) : null;
      if (existing) {
        const updated = { ...existing, ...args?.update, updatedAt: new Date() };
        if (id) getStore(modelName).set(id, updated);
        return updated;
      }
      const created = {
        id: id || `mock_${Date.now()}`,
        ...args?.create,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (id) getStore(modelName).set(id, created);
      return created;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete: async (args: any) => {
      const id = args?.where?.id || args?.where?.matricNumber;
      if (id) getStore(modelName).delete(id);
      return { id };
    },
    deleteMany: async () => ({ count: 0 }),
    count: async () => getStore(modelName).size,
    aggregate: async () => ({ _sum: { amount: 0 }, _count: { id: 0 } }),
    groupBy: async () => [],
  };
};

// ─── Mock shell — wraps $connect / $disconnect / $queryRaw / $transaction ─────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock: any = {
  $connect: async (): Promise<void> => {
    if (realPrisma) {
      try {
        await realPrisma.$connect();
        logger.info("prisma.postgres_connected");
      } catch (error) {
        if (isLiveLikeEnvironment) {
          // Hard-fail in production — never silently fall back to the mock.
          throw error;
        }
        logger.warn("prisma.postgres_offline — using in-memory mock store");
      }
      return;
    }
    logger.warn("prisma.postgres_mock_active — no real client available");
  },
  $disconnect: async (): Promise<void> => {
    if (realPrisma) {
      try {
        await realPrisma.$disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
  },
  // Passthrough to real client when available, otherwise satisfy the health check.
  $queryRaw: async (...args: unknown[]) => {
    if (realPrisma) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realPrisma as any).$queryRaw(...args);
    }
    return [{ 1: 1, "?column?": 1 }];
  },
  $executeRaw: async (...args: unknown[]) => {
    if (realPrisma) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realPrisma as any).$executeRaw(...args);
    }
    return 1;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: async (arg: any) => {
    if (realPrisma) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realPrisma as any).$transaction(arg);
    }
    // Mock fallback — only reached in development with no Postgres.
    if (typeof arg === "function") {
      return arg(prisma);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg;
  },
};

// ─── Proxy ───────────────────────────────────────────────────────────────────
//
// Resolution order:
//  1. Symbol props — always from the mock shell (avoids Proxy infinite loops).
//  2. Props defined on the mock shell ($connect, $disconnect, etc.) — use shell.
//  3. If realPrisma is initialised → delegate to it directly.
//     Prisma handles its own lazy connection; we do NOT gate on isConnected.
//     This is what makes serverless / Vercel work: each invocation gets a fresh
//     module import, realPrisma is constructed, and the first query opens the
//     pooled connection without requiring a prior explicit $connect() call.
//  4. Fallback → in-memory mock model (development only, Postgres offline).
//
const prisma = new Proxy(prismaMock, {
  get(target, prop: string | symbol) {
    if (typeof prop === "symbol")
      return (target as Record<string | symbol, unknown>)[prop];
    if (prop in target) return (target as Record<string, unknown>)[prop];

    // Delegate to real Prisma whenever the client was successfully constructed.
    // Do NOT check isConnected — Prisma is lazy and handles reconnection itself.
    if (realPrisma && prop in realPrisma) {
      return (realPrisma as unknown as Record<string, unknown>)[prop];
    }

    // Only reach here in development when Postgres is offline.
    if (isLiveLikeEnvironment) {
      // Throw rather than silently return mock data in production.
      throw new Error(
        `prisma.${String(
          prop
        )} called but real Prisma client is not available in ${env.NODE_ENV}`
      );
    }

    return createMockModel(prop);
  },
}) as unknown as PrismaClient;

export { prisma };
export default prisma;
