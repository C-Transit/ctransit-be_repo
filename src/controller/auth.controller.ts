import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import env from "../config/env.js";
import { generateOTP, verifyOTPToken, sendOTPEmail } from "../services/otp.service.js";
import { confirmRegistration } from "../services/registration.service.js";
import {
  issueRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  signAccessToken,
} from "../services/token.service.js";
import { isLocked, recordFailure, clearFailures } from "../services/lockout.service.js";
import { isValidPassword, PASSWORD_RULE_MESSAGE } from "../utils/password.js";

export interface AuthenticatedRequest extends Request {
  user?: { userId: string; role?: string };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");
const LOCKED_MESSAGE = "Too many failed attempts. Try again in 15 minutes.";
// Real hash so a login for an unknown email costs the same as a real one.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

const isValidInstitutionEmail = (email: string) => email.endsWith(env.auth.allowedEmailDomain);

const serverError = (res: Response, err: unknown, event: string) => {
  logger.error({ err: errMsg(err) }, event);
  return res.status(500).json({ message: "Server error" });
};

export const registerStudent = async (req: Request, res: Response) => {
  try {
    const { firstname, lastname, email, matricNumber, password } = req.body ?? {};
    if (!firstname || !lastname || !email || !matricNumber || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const mail = String(email).toLowerCase();
    const matric = String(matricNumber).toUpperCase();

    if (!isValidPassword(password)) {
      return res.status(400).json({ message: PASSWORD_RULE_MESSAGE });
    }
    if (!isValidInstitutionEmail(mail)) {
      return res.status(400).json({ message: `Only ${env.auth.allowedEmailDomain} email addresses are accepted` });
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: mail }, { matricNumber: matric }] },
      select: { id: true },
    });
    if (existing) return res.status(400).json({ message: "User already exists" });

    await prisma.user.create({
      data: {
        firstname,
        lastname,
        email: mail,
        matricNumber: matric,
        password: await bcrypt.hash(password, 10),
        role: "STUDENT",
        isVerified: false,
      },
    });

    await sendOTPEmail(mail, generateOTP(mail));
    logger.info({ email: mail }, "auth.registration_successful_otp_sent");
    return res.status(201).json({ message: "Registration successful. Check your email for the OTP." });
  } catch (error) {
    return serverError(res, error, "auth.registration_error");
  }
};

export const verifyOTP = async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body ?? {};
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });

    const mail = String(email).toLowerCase();
    const lockKey = `verify:${mail}`;
    if (await isLocked(lockKey)) {
      logger.warn({ email: mail }, "auth.verify_otp_locked");
      return res.status(429).json({ message: LOCKED_MESSAGE });
    }

    const user = await prisma.user.findUnique({ where: { email: mail }, select: { isVerified: true } });
    if (!user) {
      logger.warn({ email: mail }, "auth.verify_otp_user_not_found");
      return res.status(404).json({ message: "User not found" });
    }
    if (user.isVerified) return res.status(400).json({ message: "Email already verified" });

    if (!verifyOTPToken(mail, String(otp))) {
      recordFailure(lockKey);
      logger.warn({ email: mail }, "auth.verify_otp_invalid_or_expired");
      return res.status(400).json({ message: "Invalid or expired OTP. Please request a new one." });
    }
    clearFailures(lockKey);

    await prisma.user.update({ where: { email: mail }, data: { isVerified: true } });
    logger.info({ email: mail }, "auth.otp_verified_successfully");
    return res.status(200).json({ message: "Email verified successfully. You can now log in." });
  } catch (error) {
    return serverError(res, error, "auth.verify_otp_error");
  }
};

export const resendOTP = async (req: Request, res: Response) => {
  try {
    const { email } = req.body ?? {};
    if (!email) return res.status(400).json({ message: "Email is required" });

    const mail = String(email).toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: mail }, select: { isVerified: true } });

    if (!user) {
      logger.warn({ email: mail }, "auth.resend_otp_user_not_found");
      return res.status(404).json({ message: "User not found" });
    }
    if (user.isVerified) return res.status(400).json({ message: "Email is already verified" });

    await sendOTPEmail(mail, generateOTP(mail));
    logger.info({ email: mail }, "auth.otp_resent");
    return res.status(200).json({ message: "A new OTP has been sent to your email" });
  } catch (error) {
    return serverError(res, error, "auth.resend_otp_error");
  }
};

export const loginStudent = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ message: "Please provide email and password" });

    const mail = String(email).toLowerCase();
    if (!isValidInstitutionEmail(mail)) {
      return res.status(400).json({ message: `Only ${env.auth.allowedEmailDomain} email addresses are accepted` });
    }

    const lockKey = `student:${mail}`;
    if (await isLocked(lockKey)) {
      logger.warn({ email: mail }, "auth.login_locked");
      return res.status(429).json({ message: LOCKED_MESSAGE });
    }

    const user = await prisma.user.findUnique({ where: { email: mail } });
    const validPassword = await bcrypt.compare(String(password), user?.password ?? DUMMY_HASH);

    if (!user || user.role !== "STUDENT" || !validPassword) {
      recordFailure(lockKey);
      logger.warn({ email: mail }, "auth.login_invalid_credentials");
      return res.status(400).json({ message: "Invalid email or password" });
    }
    clearFailures(lockKey);

    // Only reveal "not verified" to someone who proved they know the password.
    if (!user.isVerified) {
      logger.warn({ email: mail }, "auth.login_email_not_verified");
      return res.status(403).json({ message: "Email not verified. Please check your email for the OTP." });
    }

    const payload = { userId: user.id, role: user.role, email: user.email };
    const accessToken = signAccessToken(payload);
    const refreshToken = await issueRefreshToken(payload);

    logger.info({ userId: user.id }, "auth.login_successful");
    return res.status(200).json({ accessToken, refreshToken, message: "Login successful" });
  } catch (error) {
    return serverError(res, error, "auth.login_error");
  }
};

export const loginAdmin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ message: "Please provide email and password" });

    const mail = String(email).toLowerCase();
    const lockKey = `admin:${mail}`;
    if (await isLocked(lockKey)) {
      logger.warn({ email: mail }, "auth.admin_login_locked");
      return res.status(429).json({ message: LOCKED_MESSAGE });
    }

    const user = await prisma.user.findUnique({ where: { email: mail } });
    const validPassword = await bcrypt.compare(String(password), user?.password ?? DUMMY_HASH);

    if (!user || user.role !== "ADMIN" || !validPassword) {
      recordFailure(lockKey);
      logger.warn({ email: mail }, "auth.admin_login_failed");
      return res.status(401).json({ message: "Invalid email or password" });
    }
    clearFailures(lockKey);

    const payload = { userId: user.id, role: user.role, email: user.email };
    const accessToken = signAccessToken(payload);
    const refreshToken = await issueRefreshToken(payload);

    logger.info({ userId: user.id }, "auth.admin_login_successful");
    return res.status(200).json({ accessToken, refreshToken, message: "Login successful" });
  } catch (error) {
    return serverError(res, error, "auth.admin_login_error");
  }
};

export const logoutStudent = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (refreshToken) {
      const payload = await verifyRefreshToken(refreshToken);
      if (payload) await revokeRefreshToken(payload.tokenId);
    }
    logger.info("auth.logout_successful");
    return res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    logger.error({ err: errMsg(err) }, "auth.logout_failed");
    return res.status(500).json({ success: false, message: "Internal server error during logout" });
  }
};

export const refreshAccessToken = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) return res.status(400).json({ message: "Refresh token is required" });

    const payload = await verifyRefreshToken(refreshToken);
    if (!payload) return res.status(401).json({ message: "Invalid or expired refresh token" });

    // Suspended or deactivated agents must not be able to keep refreshing.
    if (payload.role === "AGENT") {
      const agent = await prisma.agent.findUnique({ where: { id: payload.userId }, select: { status: true } });
      if (agent?.status !== "ACTIVE") return res.status(401).json({ message: "Invalid or expired refresh token" });
    }

    const accessToken = signAccessToken(payload);
    logger.info({ userId: payload.userId, role: payload.role }, "auth.token_refreshed");
    return res.status(200).json({ accessToken, token: accessToken });
  } catch (error) {
    return serverError(res, error, "auth.refresh_error");
  }
};

export const confirmCard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const otp = req.body?.otp;
    if (!otp) return res.status(400).json({ success: false, message: "OTP is required" });
    if (!/^\d{6}$/.test(String(otp))) {
      return res.status(400).json({ success: false, message: "OTP must be exactly 6 digits" });
    }

    const userId = req.user!.userId;
    const result = await confirmRegistration(String(otp), userId);
    logger.info({ userId, success: result.success }, "auth.confirm_card_result");

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    logger.error({ err: errMsg(error) }, "auth.confirm_card_error");
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getCardLinkStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { matricNumber: true },
    });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const card = await prisma.cardMapping.findUnique({
      where: { student_uid: user.matricNumber },
      select: { card_uid: true },
    });

    // Registration OTPs aren't tied to a student until confirmed, so there is no per-student
    // "pending" state to report. The student types the OTP shown on the terminal.
    return res.status(200).json({
      success: true,
      status: card ? "LINKED" : "NO_ACTIVE_OTP",
      cardUid: card?.card_uid ?? null,
      expiresAt: null,
    });
  } catch (error) {
    logger.error({ err: errMsg(error) }, "auth.card_link_status_error");
    return res.status(500).json({ success: false, message: "Failed to fetch card link status" });
  }
};