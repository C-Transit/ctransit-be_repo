import type { Request, Response } from "express";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import {
  getUserCount,
  getAllUsers,
  getUserProfile,
  updateUserProfile,
  changeUserPassword,
  requestPasswordReset,
  resetPasswordWithOTP,
} from "../services/user.service.js";
import { generateOTP, verifyOTPOnce, sendOTPEmail } from "../services/otp.service.js";
import { issueRefreshToken, signAccessToken } from "../services/token.service.js";
import { isLocked, recordFailure, clearFailures, takeCooldown } from "../services/lockout.service.js";
import { isValidPassword, PASSWORD_RULE_MESSAGE } from "../utils/password.js";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");

const serverError = (res: Response, err: unknown, event: string, message: string) => {
  logger.error({ err: errMsg(err) }, event);
  return res.status(500).json({ success: false, message });
};

export const fetchUserCount = async (_req: Request, res: Response) => {
  try {
    res.status(200).json({ success: true, data: { count: await getUserCount() } });
  } catch (error) {
    serverError(res, error, "user.fetch_count_error", "Failed to fetch user count");
  }
};

export const fetchAllUsers = async (_req: Request, res: Response) => {
  try {
    res.status(200).json({ success: true, data: { users: await getAllUsers() } });
  } catch (error) {
    serverError(res, error, "user.fetch_all_users_error", "Failed to fetch users");
  }
};

export const fetchProfile = async (req: CustomAuthRequest, res: Response) => {
  try {
    const profile = await getUserProfile(req.user!.userId);
    res.status(200).json({ success: true, data: { profile } });
  } catch (error) {
    if (errMsg(error) === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    serverError(res, error, "user.fetch_profile_error", "Failed to fetch user profile");
  }
};

export const updateProfile = async (req: CustomAuthRequest, res: Response) => {
  const { firstname, lastname } = req.body ?? {};

  const invalid = [firstname, lastname].some(
    (n) => n !== undefined && (typeof n !== "string" || n.length > 50)
  );
  if (invalid) {
    return res.status(400).json({ success: false, message: "Names must be text of at most 50 characters" });
  }
  if (!firstname?.trim() && !lastname?.trim()) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one field to update: firstname, lastname",
    });
  }

  try {
    const profile = await updateUserProfile(req.user!.userId, { firstname, lastname });
    res.status(200).json({
      success: true,
      message: "User profile updated successfully",
      data: { profile },
    });
  } catch (error) {
    serverError(res, error, "user.update_profile_error", "Failed to update user profile");
  }
};

const CHANGE_PASSWORD_ERRORS: Record<string, [number, string]> = {
  CURRENT_PASSWORD_INCORRECT: [400, "Current password is incorrect"],
  PASSWORD_UNCHANGED: [400, "New password must be different from current password"],
  USER_NOT_FOUND: [404, "User not found"],
  ROLE_NOT_ALLOWED: [403, "This account type can't change its password here"],
  TOO_MANY_ATTEMPTS: [429, "Too many failed attempts. Try again in 15 minutes."],
};

export const changePassword = async (req: CustomAuthRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body ?? {};

  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Both currentPassword and newPassword are required",
    });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ success: false, message: PASSWORD_RULE_MESSAGE });
  }

  const { userId, role, email } = req.user!;

  try {
    await changeUserPassword(userId, currentPassword, newPassword);

    // Every session was revoked: hand this device a fresh pair so it isn't signed out.
    const payload = { userId, role, email };
    const accessToken = signAccessToken(payload);
    const refreshToken = await issueRefreshToken(payload);

    logger.info({ userId }, "user.password_changed");
    res.status(200).json({ success: true, message: "Password changed successfully", accessToken, refreshToken });
  } catch (error) {
    const known = CHANGE_PASSWORD_ERRORS[errMsg(error)];
    if (known) return res.status(known[0]).json({ success: false, message: known[1] });
    serverError(res, error, "user.change_password_error", "Failed to change password");
  }
};

export const requestForgotPassword = async (req: Request, res: Response) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email) {
    return res.status(400).json({ success: false, message: "Email is required" });
  }

  try {
    // Same response whether or not the account exists, so this can't be used to find accounts.
    // The email is sent in the background so response time doesn't reveal it either.
    if ((await takeCooldown(`reset_req:${email}`, 60)) && (await requestPasswordReset(email))) {
      sendOTPEmail(email, generateOTP(email, "reset"), "reset").catch((err) =>
        logger.error({ err: errMsg(err) }, "user.forgot_password_email_failed")
      );
    }

    res.status(200).json({
      success: true,
      message: "If an account exists for this email, an OTP has been sent to it.",
    });
  } catch (error) {
    serverError(res, error, "user.forgot_password_request_error", "Failed to process password reset request");
  }
};

export const resetForgotPassword = async (req: Request, res: Response) => {
  const { email: rawEmail, otp, newPassword } = req.body ?? {};

  if (!rawEmail || !otp || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Email, OTP, and new password are required",
    });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ success: false, message: PASSWORD_RULE_MESSAGE });
  }

  const email = String(rawEmail).trim().toLowerCase();
  const lockKey = `reset:${email}`;

  try {
    if (await isLocked(lockKey)) {
      return res.status(429).json({ success: false, message: "Too many failed attempts. Try again in 15 minutes." });
    }

    // Wrong code, reused code and ineligible account all look identical to the caller.
    const done = (await verifyOTPOnce(email, String(otp), "reset")) && (await resetPasswordWithOTP(email, newPassword));
    if (!done) {
      recordFailure(lockKey);
      logger.warn({ email }, "user.forgot_password_invalid_otp");
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP. Please request a new one.",
      });
    }
    clearFailures(lockKey);

    logger.info({ email }, "user.password_reset_successfully");
    res.status(200).json({
      success: true,
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (error) {
    serverError(res, error, "user.reset_password_error", "Failed to reset password");
  }
};