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
    if (typeof prop === "symbol")
      return (target as Record<string | symbol, unknown>)[prop];
    if (prop in target) return (target as Record<string, unknown>)[prop];

    // NEW — correct for serverless
    if (realPrisma && prop in realPrisma) {
      return (realPrisma as unknown as Record<string, unknown>)[prop];
    }
  },
}) as unknown as PrismaClient;

export { prisma };
export default prisma;
