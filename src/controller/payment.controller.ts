import type { Response } from "express";
import type { AuthenticatedRequest } from "./auth.controller.js";
import {
  createVirtualAccountForStudent,
  getVirtualAccount,
} from "../services/payment.service.js";
import logger from "../config/logger.js";

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
