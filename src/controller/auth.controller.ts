// src/controller/auth.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import logger from "../config/logger.js";
import env from "../config/env.js";
import {
  generateOTP,
  verifyOTPToken,
  sendOTPEmail,
} from "../services/otp.service.js";
import { confirmRegistration } from "../services/registration.service.js";
import {
  issueRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
} from "../services/token.service.js";

// Interface to handle routes protected by auth middleware
export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    role?: string;
  };
}

const isValidInstitutionEmail = (email: string): boolean => {
  return email.toLowerCase().endsWith(env.auth.allowedEmailDomain);
};

const isValidPassword = (password: string): boolean => {
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  return passwordRegex.test(password);
};

// ─────────────────────────────────────────────
// registerStudent
// ─────────────────────────────────────────────
export const registerStudent = async (req: Request, res: Response) => {
  try {
    const { firstname, lastname, email, matricNumber, password } = req.body;

    if (!firstname || !lastname || !email || !matricNumber || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters and contain uppercase, lowercase, and numbers",
      });
    }
    if (!isValidInstitutionEmail(email)) {
      return res.status(400).json({
        message: `Only ${env.auth.allowedEmailDomain} email addresses are accepted`,
      });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: email.toLowerCase() }, { matricNumber }],
      },
    });

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        firstname,
        lastname,
        email: email.toLowerCase(),
        matricNumber: matricNumber.toUpperCase(),
        password: hashedPassword,
        role: "STUDENT",
        isVerified: false,
      },
    });

    const otp = generateOTP(email.toLowerCase());
    await sendOTPEmail(email.toLowerCase(), otp);

    logger.info(
      { email: email.toLowerCase() },
      "auth.registration_successful_otp_sent"
    );
    return res.status(201).json({
      message: "Registration successful. Check your email for the OTP.",
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "auth.registration_error");
    return res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────
// verifyOTP
// ─────────────────────────────────────────────
export const verifyOTP = async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      logger.warn(
        { email: email.toLowerCase() },
        "auth.verify_otp_user_not_found"
      );
      return res.status(404).json({ message: "User not found" });
    }
    if (user.isVerified) {
      return res.status(400).json({ message: "Email already verified" });
    }

    const isValid = verifyOTPToken(email.toLowerCase(), otp);
    if (!isValid) {
      logger.warn(
        { email: email.toLowerCase() },
        "auth.verify_otp_invalid_or_expired"
      );
      return res.status(400).json({
        message: "Invalid or expired OTP. Please request a new one.",
      });
    }

    await prisma.user.update({
      where: { email: email.toLowerCase() },
      data: { isVerified: true },
    });

    logger.info(
      { email: email.toLowerCase() },
      "auth.otp_verified_successfully"
    );
    return res.status(200).json({
      message: "Email verified successfully. You can now log in.",
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "auth.verify_otp_error");
    return res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────
// resendOTP
// ─────────────────────────────────────────────
export const resendOTP = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      logger.warn(
        { email: email.toLowerCase() },
        "auth.resend_otp_user_not_found"
      );
      return res.status(404).json({ message: "User not found" });
    }
    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    const otp = generateOTP(email.toLowerCase());
    await sendOTPEmail(email.toLowerCase(), otp);

    logger.info({ email: email.toLowerCase() }, "auth.otp_resent");
    return res.status(200).json({
      message: "A new OTP has been sent to your email",
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "auth.resend_otp_error");
    return res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────
// loginStudent
// Issues accessToken (1h) + refreshToken (7d).
// email is included in payload to match UserJwtPayload
// interface declared in auth.middleware.ts.
// ─────────────────────────────────────────────
export const loginStudent = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Please provide email and password" });
    }
    if (!isValidInstitutionEmail(email)) {
      return res.status(400).json({
        message: `Only ${env.auth.allowedEmailDomain} email addresses are accepted`,
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      logger.warn({ email: email.toLowerCase() }, "auth.login_user_not_found");
      return res.status(400).json({ message: "Invalid email or password" });
    }
    if (!user.isVerified) {
      logger.warn(
        { email: email.toLowerCase() },
        "auth.login_email_not_verified"
      );
      return res.status(403).json({
        message: "Email not verified. Please check your email for the OTP.",
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      logger.warn(
        { email: email.toLowerCase() },
        "auth.login_invalid_password"
      );
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const accessToken = jwt.sign(
      { userId: user.id, role: user.role, email: user.email },
      env.jwt.secret,
      { expiresIn: "1h" }
    );

    const refreshToken = await issueRefreshToken({
      userId: user.id,
      role: user.role,
      email: user.email,
    });

    logger.info(
      { email: email.toLowerCase(), userId: user.id },
      "auth.login_successful"
    );
    return res.status(200).json({
      accessToken,
      refreshToken,
      message: "Login successful",
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "auth.login_error");
    return res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────
// loginAdmin
// Bypasses institution email check.
// Issues accessToken (8h) + refreshToken (7d).
// Vague error messages — never reveal whether
// the account exists.
// ─────────────────────────────────────────────
export const loginAdmin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Please provide email and password" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user || user.role !== "ADMIN") {
      logger.warn({ email: email.toLowerCase() }, "auth.admin_login_failed");
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      logger.warn(
        { email: email.toLowerCase() },
        "auth.admin_login_invalid_password"
      );
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const accessToken = jwt.sign(
      { userId: user.id, role: user.role, email: user.email },
      env.jwt.secret,
      { expiresIn: "8h" } // Longer than student — admin sessions are supervised
    );

    const refreshToken = await issueRefreshToken({
      userId: user.id,
      role: user.role,
      email: user.email,
    });

    logger.info(
      { email: email.toLowerCase(), userId: user.id },
      "auth.admin_login_successful"
    );
    return res.status(200).json({
      accessToken,
      refreshToken,
      message: "Login successful",
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "auth.admin_login_error");
    return res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────
// logoutStudent
// Revokes the refresh token from Redis — instant
// invalidation regardless of JWT expiry time.
// Accepts refreshToken in request body.
// ─────────────────────────────────────────────
export const logoutStudent = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      // Extract tokenId from the JWT, then delete from Redis.
      // We ignore errors here — logging out should always succeed
      // even if the token is already expired or invalid.
      const payload = await verifyRefreshToken(refreshToken);
      if (payload) {
        await revokeRefreshToken(payload.tokenId);
      }
    }

    logger.info("auth.logout_successful");
    return res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (err) {
    logger.error({ err }, "auth.logout_failed");
    return res.status(500).json({
      success: false,
      message: "Internal server error during logout",
    });
  }
};

// ─────────────────────────────────────────────
// refreshAccessToken
// Verifies the refresh token against Redis,
// issues a new accessToken. The refresh token
// TTL does not reset on use — no sliding sessions.
// This prevents indefinite extension without
// re-authentication.
// ─────────────────────────────────────────────
export const refreshAccessToken = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ message: "Refresh token is required" });
    }

    const payload = await verifyRefreshToken(refreshToken);

    if (!payload) {
      // Covers: invalid signature, expired JWT, revoked (DEL'd from Redis)
      return res
        .status(401)
        .json({ message: "Invalid or expired refresh token" });
    }

    // Admin gets longer-lived access tokens than students/agents
    const expiresIn = payload.role === "ADMIN" ? "8h" : "1h";

    const accessToken = jwt.sign(
      { userId: payload.userId, role: payload.role, email: payload.email },
      env.jwt.secret,
      { expiresIn }
    );

    logger.info({ userId: payload.userId }, "auth.token_refreshed");
    return res.status(200).json({ accessToken });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "auth.refresh_error");
    return res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────
// confirmCard
// ─────────────────────────────────────────────
export const confirmCard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { otp } = req.body;

    if (!otp) {
      return res
        .status(400)
        .json({ success: false, message: "OTP is required" });
    }

    // OTP must be exactly 6 digits
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "OTP must be exactly 6 digits",
      });
    }

    const result = await confirmRegistration(otp, userId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "auth.confirm_card_error");
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// src/controller/auth.controller.ts – add this function

export const getCardLinkStatus = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Get student's matric number
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { matricNumber: true },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if card is already linked
    const cardMap = await prisma.cardMapping.findUnique({
      where: { student_uid: user.matricNumber },
      select: { card_uid: true },
    });

    if (cardMap) {
      return res.status(200).json({
        success: true,
        status: 'LINKED',
        cardUid: cardMap.card_uid,
        expiresAt: null,
      });
    }

    // Check if there's a pending OTP for this student
    // Note: OTP is associated with card_uid, not student, but we can check
    // if there's any OTP that is not used and not expired in the system
    const pendingOtp = await prisma.registrationOtp.findFirst({
      where: {
        used: false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
      select: { otp: true, expires_at: true, card_uid: true },
    });

    if (pendingOtp) {
      return res.status(200).json({
        success: true,
        status: 'PENDING',
        cardUid: pendingOtp.card_uid,
        expiresAt: pendingOtp.expires_at,
      });
    }

    return res.status(200).json({
      success: true,
      status: 'NO_ACTIVE_OTP',
      cardUid: null,
      expiresAt: null,
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: errMessage }, 'auth.card_link_status_error');
    return res.status(500).json({ success: false, message: 'Failed to fetch card link status' });
  }
};