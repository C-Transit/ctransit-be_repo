import type { Response, NextFunction } from "express";
import { confirmRegistration } from "../services/registration.service.js";
import { getVirtualAccount } from "../services/payment.service.js";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";

export const requireStudentAuth = (req: CustomAuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== "STUDENT") {
    logger.warn({ userId: req.user?.userId, ip: req.ip }, "wallets.unauthorized_access");
    return res.status(401).json({ success: false, message: "Student authentication required" });
  }
  next();
};

interface LinkBody {
  otp?: string;
}

export const linkWallet = async (req: CustomAuthRequest, res: Response) => {
  const { otp } = req.body as LinkBody;
  const studentId = req.user?.userId;

  if (!studentId) {
    logger.warn({ ip: req.ip }, "wallets.link_failed_missing_auth");
    return res.status(401).json({ success: false, message: "Unauthorized: Student ID missing from token" });
  }

  if (!otp) {
    return res.status(400).json({ success: false, message: "OTP is required" });
  }

  try {
    const result = await confirmRegistration(otp, studentId);
    if (result.success) {
      logger.info({ studentId }, "wallets.card_linked_successfully");
      return res.status(200).json(result);
    }
    return res.status(400).json(result);
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage, studentId }, "wallets.link_error");
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getWalletDetails = async (req: CustomAuthRequest, res: Response) => {
  const userId = req.user?.userId;

  if (!userId) {
    logger.warn({ ip: req.ip }, "wallets.details_failed_missing_auth");
    return res.status(401).json({ success: false, message: "Unauthorized: Student ID missing from token" });
  }

  try {
    const details = await getVirtualAccount(userId);

    return res.status(200).json({
      success: true,
      data: {
        balance: details.balance,
        accountNumber: details.accountNumber,
        bank: details.bankName,
        bankName: details.bankName,
      },
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage, userId }, "wallets.details_error");

    if (error instanceof Error && error.message === "WALLET_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    return res.status(500).json({ success: false, message: "Failed to fetch wallet details" });
  }
};