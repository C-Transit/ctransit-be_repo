// src/config/env.ts
import "dotenv/config";

const REQUIRED_VARS = [
  "DATABASE_URL",
  "DATABASE_URL_POOLED",
  "REDIS_URL",
  "ADMIN_API_SECRET",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "OTP_SECRET",
  "MAIL_USER",
  "MAIL_PASSWORD",
  "ALLOWED_EMAIL_DOMAIN",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "PAYMENT_PROVIDER",
  "PAYMENT_SECRET_KEY",
  "MQTT_INTERNAL_URL",
  "MQTT_INTERNAL_SECRET",
] as const;

const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

if (missing.length > 0) {
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      msg: "Some environment variables are not set. Using development fallbacks.",
      missing,
    }) + "\n"
  );
}

const parseIntSafe = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseFloatSafe = (
  value: string | undefined,
  fallback: number
): number => {
  if (!value) return fallback;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

interface Config {
  NODE_ENV: string;
  PORT: number;
  db: {
    url: string;
    pooledUrl: string;
  };
  redis: {
    url: string;
  };
  ledger: {
    baseFare: number;
  };
  admin: {
    secret: string;
  };
  jwt: {
    secret: string;
    refreshSecret: string; // ← added
  };
  otp: {
    secret: string;
  };
  mail: {
    user: string;
    password: string;
  };
  auth: {
    allowedEmailDomain: string;
  };
  cloudinary: {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
  };
  payment: {
    provider: string;
    secretKey: string;
  };
  mqtt: {
    internalUrl: string;
    internalSecret: string;
  };
  rateLimit: {
    global: { windowMs: number; max: number };
    login: { windowMs: number; max: number };
    adminLogin: { windowMs: number; max: number };
    register: { windowMs: number; max: number };
    otp: { windowMs: number; max: number };
    kyc: { windowMs: number; max: number };
    kycStatus: { windowMs: number; max: number };
    transactions: { windowMs: number; max: number };
    wallets: { windowMs: number; max: number };
    disputes: { windowMs: number; max: number };
    notifications: { windowMs: number; max: number };
  };
}

const env: Config = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseIntSafe(process.env.PORT, 3000),
  db: {
    url: process.env.DATABASE_URL || "postgresql://mock:mock@localhost:5432/ctransit?sslmode=disable",
    pooledUrl: process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || "postgresql://mock:mock@localhost:5432/ctransit?sslmode=disable",
  },
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  ledger: {
    baseFare: parseFloatSafe(process.env.BASE_FARE, 150),
  },
  admin: {
    secret: process.env.ADMIN_API_SECRET || "dev_admin_api_secret_default_key",
  },
  jwt: {
    secret: process.env.JWT_SECRET || "dev_jwt_secret_default_key_ctransit",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "dev_jwt_refresh_secret_default_key_ctransit",
  },
  otp: {
    secret: process.env.OTP_SECRET || "dev_otp_secret_key_1234567890",
  },
  mail: {
    user: process.env.MAIL_USER || "notifications@ctransit.me",
    password: process.env.MAIL_PASSWORD || "dev_mail_password",
  },
  auth: {
    allowedEmailDomain: process.env.ALLOWED_EMAIL_DOMAIN || "@covenantuniversity.edu.ng",
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "demo",
    apiKey: process.env.CLOUDINARY_API_KEY || "demo_key",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "demo_secret",
  },
  rateLimit: {
    // ── Edit these values to tune limits without touching middleware ──
    global: { windowMs: 15 * 60 * 1000, max: 100 },
    login: { windowMs: 15 * 60 * 1000, max: 5 },
    adminLogin: { windowMs: 15 * 60 * 1000, max: 3 },
    register: { windowMs: 60 * 60 * 1000, max: 5 },
    otp: { windowMs: 15 * 60 * 1000, max: 3 },
    kyc: { windowMs: 60 * 60 * 1000, max: 3 },
    kycStatus: { windowMs: 15 * 60 * 1000, max: 20 },
    transactions: { windowMs: 15 * 60 * 1000, max: 30 },
    wallets: { windowMs: 15 * 60 * 1000, max: 30 },
    disputes: { windowMs: 60 * 60 * 1000, max: 5 },
    notifications: { windowMs: 15 * 60 * 1000, max: 30 },
  },
  payment: {
    provider: process.env.PAYMENT_PROVIDER || "mock",
    secretKey: process.env.PAYMENT_SECRET_KEY || "mock_secret_key",
  },
  mqtt: {
    internalUrl: process.env.MQTT_INTERNAL_URL || "http://localhost:4000",
    internalSecret: process.env.MQTT_INTERNAL_SECRET || "mock_mqtt_secret",
  },
};

export default env;
