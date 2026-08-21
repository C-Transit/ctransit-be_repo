import prisma from "../lib/prisma.js";
import logger from "./logger.js";

const connectDB = async (): Promise<void> => {
  try {
    await prisma.$connect();
    logger.info("db.connected_successfully");
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown database connection error";
    logger.warn({ err: errorMessage }, "db.connection_warning — database offline or unconfigured");
  }
};

const disconnectDB = async (): Promise<void> => {
  await prisma.$disconnect();
};

export { prisma, connectDB, disconnectDB };
export default connectDB;
