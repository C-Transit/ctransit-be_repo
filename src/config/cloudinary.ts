import { v2 as cloudinary } from "cloudinary";
import env from "./env.js";
import logger from "./logger.js";

// Configure Cloudinary with credentials from .env
cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
});

// Exported so it can be called during your app's initialization
export const testCloudinaryConnection = async (): Promise<boolean> => {
  try {
    await cloudinary.api.ping();
    logger.info({ cloudName: env.cloudinary.cloudName }, "cloudinary.connection_successful");
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown Cloudinary connection error";
    logger.error({ err: errorMessage }, "cloudinary.connection_failed");
    process.exit(1); // Exit if Cloudinary is not reachable
  }
};

export default cloudinary;