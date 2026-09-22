import pino, { type LoggerOptions } from "pino";
import env from "./env.js";

const isDev = env.NODE_ENV === "development";

const loggerOptions: LoggerOptions = {
  level: isDev ? "debug" : "info",
  base: {
    service: "ctransit-backend-hardware-link",
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    paths: [
      "mqtt.password",
      "redis.password",
      "*.secret_key",
      "*.secretKey",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "password",
      "newPassword",
      "currentPassword",
      "adminPassword",
      "*.authorization",
      "authorization",
      "Authorization",
      "headers.authorization",
      "headers.Authorization",
      "headers['authorization']",
      "headers['Authorization']",
      "headers['x-admin-secret']",
      "headers['x-korapay-signature']",
      "headers['fincra-signature']",
      "*.kora_secret",
      "*.koraSecret",
      "kora_secret",
      "koraSecret",
      "*.secret",
      "secret",
      "token",
      "*.token",
      "accessToken",
      "*.accessToken",
      "refreshToken",
      "*.refreshToken",
      "jwt",
      "*.jwt",
      "signature",
      "*.signature",
      "otp",
      "*.otp",
    ],
    censor: "[REDACTED]",
  },
  
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname,service,env",
        singleLine: true,
      },
    },
  }),
};

const logger = pino(loggerOptions);

export default logger;
