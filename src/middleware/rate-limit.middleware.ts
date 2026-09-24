// To adjust any limit: edit env.ts - rateLimit section only.
import rateLimit from "express-rate-limit";
import env from "../config/env.js";

const buildLimiter = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });

const { rateLimit: rl } = env;

// Auth 
export const loginLimiter = buildLimiter(
  rl.login.windowMs,
  rl.login.max,
  "Too many login attempts. Please try again in 15 minutes."
);

export const adminLoginLimiter = buildLimiter(
  rl.adminLogin.windowMs,
  rl.adminLogin.max,
  "Too many admin login attempts. Please try again in 15 minutes."
);

export const registerLimiter = buildLimiter(
  rl.register.windowMs,
  rl.register.max,
  "Too many registration attempts. Please try again in an hour."
);

export const otpLimiter = buildLimiter(
  rl.otp.windowMs,
  rl.otp.max,
  "Too many OTP requests. Please try again in 15 minutes."
);

// KYC
export const kycSubmitLimiter = buildLimiter(
  rl.kyc.windowMs,
  rl.kyc.max,
  "Too many KYC submissions. Please try again in an hour."
);

export const kycStatusLimiter = buildLimiter(
  rl.kycStatus.windowMs,
  rl.kycStatus.max,
  "Too many status checks. Please try again in 15 minutes."
);

//  Transactions
export const transactionLimiter = buildLimiter(
  rl.transactions.windowMs,
  rl.transactions.max,
  "Too many transaction requests. Please try again in 15 minutes."
);

//  Wallets
export const walletLimiter = buildLimiter(
  rl.wallets.windowMs,
  rl.wallets.max,
  "Too many wallet requests. Please try again in 15 minutes."
);

//  Disputes 
export const disputeLimiter = buildLimiter(
  rl.disputes.windowMs,
  rl.disputes.max,
  "Too many dispute submissions. Please try again in an hour."
);

//  Notifications
export const notificationLimiter = buildLimiter(
  rl.notifications.windowMs,
  rl.notifications.max,
  "Too many notification requests. Please try again in 15 minutes."
);

//  Driver PIN & Bank Verification
export const driverPinLimiter = buildLimiter(
  15 * 60 * 1000,
  10,
  "Too many PIN configuration attempts. Please try again in 15 minutes."
);

export const driverCardLinkLimiter = buildLimiter(
  15 * 60 * 1000,
  10,
  "Too many card-link attempts. Please try again in 15 minutes."
);

export const bankVerifyLimiter = buildLimiter(
  15 * 60 * 1000,
  15,
  "Too many bank verification requests. Please try again in 15 minutes."
);

export const globalLimiter = buildLimiter(
  rl.global.windowMs,
  rl.global.max,
  "Too many requests. Please try again in 15 minutes."
);
