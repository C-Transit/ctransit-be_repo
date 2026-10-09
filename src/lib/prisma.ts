import { PrismaClient } from "@prisma/client";
import env from "../config/env.js";

// schema.prisma's `url` is the pooled pgBouncer URL. Live uses it as-is; dev
// connects directly to avoid pgBouncer's prepared-statement restrictions.
const url = env.isLive ? env.db.pooledUrl : env.db.url;

export const prisma = new PrismaClient({
  log: env.isLive ? ["error"] : ["warn", "error"],
  errorFormat: "minimal",
  datasources: { db: { url } },
});

export default prisma;
