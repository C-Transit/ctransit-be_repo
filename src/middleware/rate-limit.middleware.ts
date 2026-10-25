// Limits for most routes are configured in env.ts (rateLimit section).
import rateLimit from "express-rate-limit";
import env from "../config/env.js";

const MIN_15 = 15 * 60 * 1000;

const buildLimiter = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });

const { rateLimit: rl } = env;
const from = (cfg: { windowMs: number; max: number }, message: string) =>
  buildLimiter(cfg.windowMs, cfg.max, message);

// Auth
export const loginLimiter = from(rl.login, "Too many login attempts. Please try again in 15 minutes.");
export const adminLoginLimiter = from(rl.adminLogin, "Too many admin login attempts. Please try again in 15 minutes.");
export const registerLimiter = from(rl.register, "Too many registration attempts. Please try again in an hour.");
export const otpLimiter = from(rl.otp, "Too many OTP requests. Please try again in 15 minutes.");

// KYC
export const kycSubmitLimiter = from(rl.kyc, "Too many KYC submissions. Please try again in an hour.");
export const kycStatusLimiter = from(rl.kycStatus, "Too many status checks. Please try again in 15 minutes.");

// Students
export const transactionLimiter = from(rl.transactions, "Too many transaction requests. Please try again in 15 minutes.");
export const walletLimiter = from(rl.wallets, "Too many wallet requests. Please try again in 15 minutes.");
export const disputeLimiter = from(rl.disputes, "Too many dispute submissions. Please try again in an hour.");
export const notificationLimiter = from(rl.notifications, "Too many notification requests. Please try again in 15 minutes.");
export const requeryLimiter = buildLimiter(MIN_15, 20, "Too many payment checks. Please try again in 15 minutes."); // NEW

// Driver PIN, card link and bank verification (the per-driver PIN lockout is the real guard)
export const driverPinLimiter = buildLimiter(MIN_15, 10, "Too many PIN configuration attempts. Please try again in 15 minutes.");
export const driverCardLinkLimiter = buildLimiter(MIN_15, 10, "Too many card-link attempts. Please try again in 15 minutes.");
export const bankVerifyLimiter = buildLimiter(MIN_15, 15, "Too many bank verification requests. Please try again in 15 minutes.");
// Read-only account-name lookups. Higher than verify because the UI resolves as the driver types.
export const bankResolveLimiter = buildLimiter(MIN_15, 30, "Too many bank lookups. Please try again in 15 minutes.");

export const globalLimiter = from(rl.global, "Too many requests. Please try again in 15 minutes.");