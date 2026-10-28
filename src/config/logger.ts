import pino, { type LoggerOptions } from "pino";
import env from "./env.js";

const isDev = env.NODE_ENV === "development";

// Field names that must never reach the logs. Each is redacted at the top level and one level deep.
const SENSITIVE_FIELDS = [
  "password",
  "newPassword",
  "currentPassword",
  "adminPassword",
  "pin",
  "otp",
  "secret",
  "secret_key",
  "secretKey",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "refreshToken",
  "refresh_token",
  "jwt",
  "signature",
  "authorization",
  "Authorization",
  "accountNumber",
];

const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-internal-secret",
  "x-admin-secret",
  "x-critical-approval-token",
  "x-korapay-signature",
];

const loggerOptions: LoggerOptions = {
  level: isDev ? "debug" : "info",
  base: { service: "ctransit-backend-hardware-link", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      "mqtt.password",
      "redis.password",
      ...SENSITIVE_FIELDS,
      ...SENSITIVE_FIELDS.map((f) => `*.${f}`),
      ...SENSITIVE_HEADERS.flatMap((h) => [`headers['${h}']`, `req.headers['${h}']`]),
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

export default pino(loggerOptions);