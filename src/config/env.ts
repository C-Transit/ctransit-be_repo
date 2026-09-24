// src/config/env.ts
import "dotenv/config";

export const REQUIRED_PRODUCTION_SECRETS = [
  "DATABASE_URL",
  "REDIS_URL",
  "ADMIN_API_SECRET",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "OTP_SECRET",
  "PAYMENT_SECRET_KEY",
  "MQTT_INTERNAL_SECRET",
] as const;

export const INSECURE_FALLBACK_SECRETS: Record<string, string> = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ctransit?schema=public",
  DATABASE_URL_POOLED: "postgresql://postgres:postgres@localhost:5432/ctransit?schema=public",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_API_SECRET: "dev_admin_secret",
  JWT_SECRET: "dev_jwt_secret",
  JWT_REFRESH_SECRET: "dev_jwt_refresh_secret",
  OTP_SECRET: "dev_otp_secret",
  PAYMENT_SECRET_KEY: "dev_payment_secret",
  MQTT_INTERNAL_SECRET: "dev_mqtt_internal_secret",
};

export const DEFAULT_DEV_VARS: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ctransit?schema=public",
  DATABASE_URL_POOLED: "postgresql://postgres:postgres@localhost:5432/ctransit?schema=public",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_API_SECRET: "dev_admin_secret",
  JWT_SECRET: "dev_jwt_secret",
  JWT_REFRESH_SECRET: "dev_jwt_refresh_secret",
  OTP_SECRET: "dev_otp_secret",
  MAIL_USER: "dev@ctransit.me",
  MAIL_PASSWORD: "dev_mail_password",
  ALLOWED_EMAIL_DOMAIN: "student.ctransit.me",
  ALLOW_MOCK_PAYMENTS: "true",
  CLOUDINARY_CLOUD_NAME: "dev_cloud",
  CLOUDINARY_API_KEY: "dev_cloud_key",
  CLOUDINARY_API_SECRET: "dev_cloud_secret",
  PAYMENT_PROVIDER: "MOCK",
  PAYMENT_SECRET_KEY: "dev_payment_secret",
  KORA_PUBLIC_KEY: "pk_test_dev",
  KORA_SECRET_KEY: "sk_test_dev",
  KORA_ENCRYPTION_KEY: "enc_test_dev",
  MQTT_INTERNAL_URL: "http://localhost:4000",
  MQTT_INTERNAL_SECRET: "dev_mqtt_internal_secret",
};

const runtimeEnvironment = process.env.NODE_ENV || "development";
const isLiveLikeEnvironment =
  runtimeEnvironment === "production" || runtimeEnvironment === "staging";

// Development defaults are never allowed to populate a production-like process.
if (!isLiveLikeEnvironment) {
  for (const [key, value] of Object.entries(DEFAULT_DEV_VARS)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function validateProductionSecrets(
  envLike: Record<string, string | undefined> = process.env
): void {
  const missing = REQUIRED_PRODUCTION_SECRETS.filter(
    (key) => !envLike[key] || envLike[key]?.trim() === ""
  );

  const insecure = REQUIRED_PRODUCTION_SECRETS.filter((key) => {
    const value = envLike[key];
    const insecureFallback = INSECURE_FALLBACK_SECRETS[key];
    return Boolean(value && insecureFallback && value === insecureFallback);
  });

  if (missing.length > 0 || insecure.length > 0) {
    const details = [
      missing.length > 0 ? `missing=${missing.join(",")}` : null,
      insecure.length > 0 ? `insecure=${insecure.join(",")}` : null,
    ]
      .filter(Boolean)
      .join(" ");

    throw new Error(
      `FATAL: Missing or insecure required production secrets. ${details}`
    );
  }
}

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
  "ALLOW_MOCK_PAYMENTS",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "PAYMENT_PROVIDER",
  "PAYMENT_SECRET_KEY",
  "KORA_PUBLIC_KEY",
  "KORA_SECRET_KEY",
  "KORA_ENCRYPTION_KEY",
  "MQTT_INTERNAL_URL",
  "MQTT_INTERNAL_SECRET",
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

if (isLiveLikeEnvironment) {
  validateProductionSecrets(process.env);
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
    criticalApprovalToken?: string;
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
    publicKey: string;
    secretKey: string;
    encryptionKey: string;
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
    criticalApprovalToken: process.env.CRITICAL_ADMIN_APPROVAL_TOKEN,
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
    provider: (process.env.PAYMENT_PROVIDER || "KORA").toUpperCase(),
    publicKey: (process.env.KORA_PUBLIC_KEY || process.env.PAYMENT_PUBLIC_KEY || "") as string,
    secretKey: (process.env.PAYMENT_SECRET_KEY || process.env.KORA_SECRET_KEY || "") as string,
    encryptionKey: (process.env.KORA_ENCRYPTION_KEY || process.env.PAYMENT_ENCRYPTION_KEY || "") as string,
  },
  mqtt: {
    internalUrl: process.env.MQTT_INTERNAL_URL as string,
    internalSecret: process.env.MQTT_INTERNAL_SECRET as string,
  },
};

export default env;
