import "dotenv/config";

const REQUIRED = [
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
  "KORA_SECRET_KEY",
  "KORA_PUBLIC_KEY",
  "MQTT_INTERNAL_URL",
  "MQTT_INTERNAL_SECRET",
] as const;

const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
if (missing.length > 0) {
  throw new Error(
    `FATAL: Missing required environment variables: ${missing.join(", ")}`
  );
}

const nodeEnv = process.env.NODE_ENV || "development";
const isLive = nodeEnv === "production" || nodeEnv === "staging";

const req = (key: (typeof REQUIRED)[number]): string =>
  process.env[key] as string;

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) ? parsed : fallback;
};

const limit = (max: number, windowMinutes = 15) => ({
  windowMs: windowMinutes * 60 * 1000,
  max,
});

const env = {
  NODE_ENV: nodeEnv,
  isLive,
  PORT: num(process.env.PORT, 3000),
  db: {
    url: req("DATABASE_URL"),
    pooledUrl: req("DATABASE_URL_POOLED"),
  },
  redis: { url: req("REDIS_URL") },
  ledger: { baseFare: num(process.env.BASE_FARE, 150) },
  admin: {
    secret: req("ADMIN_API_SECRET"),
    criticalApprovalToken: process.env.CRITICAL_ADMIN_APPROVAL_TOKEN,
  },
  jwt: {
    secret: req("JWT_SECRET"),
    refreshSecret: req("JWT_REFRESH_SECRET"),
  },
  otp: { secret: req("OTP_SECRET") },
  mail: { user: req("MAIL_USER"), password: req("MAIL_PASSWORD") },
  auth: { allowedEmailDomain: req("ALLOWED_EMAIL_DOMAIN") },
  cloudinary: {
    cloudName: req("CLOUDINARY_CLOUD_NAME"),
    apiKey: req("CLOUDINARY_API_KEY"),
    apiSecret: req("CLOUDINARY_API_SECRET"),
  },
  payment: {
    provider: req("PAYMENT_PROVIDER").toUpperCase(),
    publicKey: req("KORA_PUBLIC_KEY"),
    secretKey: req("PAYMENT_SECRET_KEY"),
    payoutWebhookUrl: process.env.PAYOUT_WEBHOOK_URL?.trim() || undefined,
    payoutProxyUrl:
      process.env.KORA_PAYOUT_PROXY_URL?.trim().replace(/\/+$/, "") || undefined,
    payoutProxySecret: process.env.PAYOUT_PROXY_SECRET?.trim() || undefined,
  },
  mqtt: {
    internalUrl: req("MQTT_INTERNAL_URL"),
    internalSecret: req("MQTT_INTERNAL_SECRET"),
  },
  rateLimit: {
    global: limit(100),
    login: limit(40),
    adminLogin: limit(8),
    register: limit(5, 60),
    otp: limit(3),
    kyc: limit(3, 60),
    kycStatus: limit(20),
    transactions: limit(30),
    wallets: limit(30),
    disputes: limit(5, 60),
    notifications: limit(30),
  },
};

if (Boolean(env.payment.payoutProxyUrl) !== Boolean(env.payment.payoutProxySecret)) {
  throw new Error(
    "FATAL: KORA_PAYOUT_PROXY_URL and PAYOUT_PROXY_SECRET must be set together"
  );
}

if (env.payment.payoutProxySecret && env.payment.payoutProxySecret.length < 32) {
  throw new Error("FATAL: PAYOUT_PROXY_SECRET must be at least 32 characters");
}

if (
  env.isLive &&
  env.payment.payoutProxyUrl &&
  !env.payment.payoutProxyUrl.startsWith("https://")
) {
  throw new Error("FATAL: KORA_PAYOUT_PROXY_URL must use https:// in production");
}

export default env;
