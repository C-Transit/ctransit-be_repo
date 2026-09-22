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
    logger.error({ err: errorMessage }, "db.connection_error");
    process.exit(1);
  }
};

const disconnectDB = async (): Promise<void> => {
  await prisma.$disconnect();
};

export { prisma, connectDB, disconnectDB };
export default connectDB;
