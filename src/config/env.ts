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
] as const;

const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

if (missing.length > 0) {
  process.stderr.write(
    JSON.stringify({
      level: "fatal",
      msg: "Missing required environment variables. Halting.",
      missing,
    }) + "\n"
  );
  process.exit(1);
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
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: parseIntSafe(process.env.PORT, 3000),
  db: {
    url: process.env.DATABASE_URL as string,
    pooledUrl: process.env.DATABASE_URL_POOLED as string,
  },
  redis: {
    url: process.env.REDIS_URL as string,
  },
  ledger: {
    baseFare: parseFloatSafe(process.env.BASE_FARE, 150),
  },
  admin: {
    secret: process.env.ADMIN_API_SECRET as string,
  },
  jwt: {
    secret: process.env.JWT_SECRET as string,
    refreshSecret: process.env.JWT_REFRESH_SECRET as string, // ← added
  },
  otp: {
    secret: process.env.OTP_SECRET as string,
  },
  mail: {
    user: process.env.MAIL_USER as string,
    password: process.env.MAIL_PASSWORD as string,
  },
  auth: {
    allowedEmailDomain: process.env.ALLOWED_EMAIL_DOMAIN as string,
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME as string,
    apiKey: process.env.CLOUDINARY_API_KEY as string,
    apiSecret: process.env.CLOUDINARY_API_SECRET as string,
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
    provider: process.env.PAYMENT_PROVIDER as string,
    secretKey: process.env.PAYMENT_SECRET_KEY as string,
  }
};

export default env;
