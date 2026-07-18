import type { Response } from "express";
import type { AuthenticatedRequest } from "./auth.controller.js";
import prisma from "../lib/prisma.js";
import { sendNotification } from "../services/notification.service.js";
import { creditWallet } from "../services/ledger.service.js";
import {
  createVirtualAccountForStudent,
  getVirtualAccount,
} from "../services/payment.service.js";
import { buildDeltaCommand } from "../utils/parser.js";
import { enqueueBroadcast } from "../utils/bridge.js";
import { hasCrossedAboveThreshold } from "../services/ledger.service.js";
import logger from "../config/logger.js";
import env from "../config/env.js";

// ─────────────────────────────────────────────
// Student requests their dedicated top-up account.
// Requires: authenticated student with approved KYC.
// ─────────────────────────────────────────────
export const requestVirtualAccount = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const result = await createVirtualAccountForStudent(userId);

    return res.status(200).json({
      success: true,
      message: result.alreadyExisted
        ? "Virtual account already exists"
        : "Virtual account created successfully",
      data: {
        accountNumber: result.accountNumber,
        bankName: result.bankName,
        reference: result.reference,
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "USER_NOT_FOUND":
          return res.status(404).json({ message: "User not found" });
        case "WALLET_NOT_ACTIVATED":
          return res.status(403).json({
            message:
              "Wallet not activated. Please complete KYC before requesting a virtual account.",
          });
      }
    }
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "payment.request_virtual_account_error");
    return res
      .status(500)
      .json({ message: "Failed to create virtual account" });
  }
};

// ─────────────────────────────────────────────
// Returns the student's existing virtual account and current wallet balance.
// ─────────────────────────────────────────────
export const getVirtualAccountDetails = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const result = await getVirtualAccount(userId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "WALLET_NOT_FOUND") {
      return res.status(404).json({ message: "Wallet not found" });
    }
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "payment.get_virtual_account_error");
    return res.status(500).json({ message: "Failed to fetch virtual account" });
  }
};

// Mock Payment for Beta Testing
export const mockTopup = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { amount } = req.body;
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount. Must be a positive number.",
      });
    }

    // Fetch user with wallet and email
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        matricNumber: true,
        firstname: true,
        wallet: {
          select: {
            balance: true,
            is_linked: true,
          },
        },
      },
    });

    if (!user || !user.wallet) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    if (!user.wallet.is_linked) {
      return res.status(403).json({
        success: false,
        message: "Wallet not linked. Please complete KYC first.",
      });
    }

    // Generate mock reference
    const reference = `MOCK-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;

    // Credit wallet and create transaction
    const { previousBalance, newBalance } = await creditWallet(
      user.matricNumber,
      amount,
      reference
    );

    logger.info(
      { previousBalance, newBalance, threshold: env.ledger.baseFare },
      "payment.mock_topup_balance_check"
    );

    if (hasCrossedAboveThreshold(previousBalance, newBalance)) {
      const cardMap = await prisma.cardMapping.findUnique({
        where: { student_uid: user.matricNumber },
        select: { card_uid: true },
      });

      if (cardMap) {
        const removeBlCmd = buildDeltaCommand("REM", "BL", cardMap.card_uid);
        await enqueueBroadcast(removeBlCmd);
        logger.info({ removeBlCmd }, "payment.mock_topup_blacklist_removed");
      }

      await prisma.blacklist.deleteMany({
        where: { student_uid: user.matricNumber },
      });
    }

    // Send email notification
    const message =
      `Dear ${user.firstname},\n\n` +
      `Your wallet has been topped up with ₦${amount.toFixed(2)}.\n` +
      `Reference: ${reference}\n` +
      `New balance: ₦${newBalance.toFixed(2)}.\n\n` +
      `Thank you for using C-Transit.`;

    sendNotification(
      user.matricNumber,
      "Wallet Top-Up Confirmation",
      message
    ).catch(() => {});

    logger.info(
      { userId, amount, reference, newBalance },
      "payment.mock_topup_success"
    );

    return res.status(200).json({
      success: true,
      message: "Top-up successful",
      data: {
        reference,
        amount,
        newBalance: newBalance.toFixed(2),
      },
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "payment.mock_topup_error");
    return res.status(500).json({
      success: false,
      message: "Failed to process top-up",
    });
  }
};