import type { Response, NextFunction } from "express";
import { confirmRegistration } from "../services/registration.service.js";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";

export const requireStudentAuth = (req: CustomAuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== "STUDENT") {
    logger.warn({ userId: req.user?.userId, role: req.user?.role, ip: req.ip }, "wallets.unauthorized_role_access");
    return res.status(403).json({ success: false, message: "Student access required" });
  }
  next();
};

export const linkWallet = async (req: CustomAuthRequest, res: Response) => {
  const otp = req.body?.otp;
  const studentId = req.user!.userId;

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
    logger.error({ err: error instanceof Error ? error.message : "Unknown error", studentId }, "wallets.link_error");
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getWalletDetails = async (req: CustomAuthRequest, res: Response) => {
  const wallet = await prisma.wallet.findFirst({
    where: { user: { id: req.user!.userId } },
    select: { balance: true },
  });

  if (!wallet) {
    return res.status(404).json({ success: false, message: "Wallet not found" });
  }

  return res.status(200).json({
    success: true,
    data: {
      balance: wallet.balance.toNumber(),
      // Virtual accounts were removed. Kept as null so older clients don't break.
      accountNumber: null,
      bank: null,
      bankName: null,
    },
  });
};