import { PrismaClient } from "@prisma/client";
import env from "../config/env.js";

const isProduction = env.NODE_ENV === "production";
const databaseUrl = isProduction ? env.db.pooledUrl : env.db.url;

const prisma = new PrismaClient({
  log: isProduction ? ["error"] : ["warn", "error"],
  errorFormat: "minimal",
  datasources: { db: { url: databaseUrl } },
});

export { prisma };
export default prisma;

