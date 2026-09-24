import { PrismaClient } from "@prisma/client";
import env from "../config/env.js";
import logger from "../config/logger.js";

const isLiveLikeEnvironment =
  env.NODE_ENV === "production" || env.NODE_ENV === "staging";
const databaseUrl = isLiveLikeEnvironment ? env.db.pooledUrl : env.db.url;

let realPrisma: PrismaClient | null = null;
let isConnected = false;

try {
  realPrisma = new PrismaClient({
    log: isLiveLikeEnvironment ? ["error"] : ["warn", "error"],
    errorFormat: "minimal",
    datasources: { db: { url: databaseUrl } },
  });
} catch (err) {
  if (isLiveLikeEnvironment) {
    throw err;
  }
  logger.warn({ err: String(err) }, "prisma.client_init_fallback");
}

// In-memory mock store
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
        args?.where?.id || args?.where?.matricNumber || args?.where?.transaction_id;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock: any = {
  $connect: async (): Promise<void> => {
    if (realPrisma) {
      try {
        await realPrisma.$connect();
        isConnected = true;
        logger.info("prisma.postgres_connected");
        return;
      } catch (error) {
        if (isLiveLikeEnvironment) {
          throw error;
        }
        logger.warn("prisma.postgres_offline — using mock store");
        isConnected = false;
        return;
      }
    }
    logger.warn("prisma.postgres_mock_active");
  },
  $disconnect: async (): Promise<void> => {
    if (realPrisma && isConnected) {
      try {
        await realPrisma.$disconnect();
      } catch {
        // ignore
      }
    }
  },
  $queryRaw: async () => [{ 1: 1, "?column?": 1 }],
  $executeRaw: async () => 1,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: async (arg: any) => {
    if (typeof arg === "function") {
      return arg(prisma);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg;
  },
};

const prisma = new Proxy(prismaMock, {
  get(target, prop: string | symbol) {
    if (typeof prop === "symbol") return (target as Record<string | symbol, unknown>)[prop];
    if (prop in target) return (target as Record<string, unknown>)[prop];

    if (isConnected && realPrisma && prop in realPrisma) {
      return (realPrisma as unknown as Record<string, unknown>)[prop];
    }

    return createMockModel(prop);
  },
}) as unknown as PrismaClient;

export { prisma };
export default prisma;


