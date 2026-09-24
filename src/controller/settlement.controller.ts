"use strict";

import type { Request, Response } from "express";
import logger from "../config/logger.js";
import env from "../config/env.js";
import { settleRide } from "../services/settlement.service.js";

// requireInternalSecret
export function requireInternalSecret(req: Request, res: Response, next: () => void): void {
  const provided = req.headers["x-internal-secret"] as string | undefined;

  if (!provided || provided !== env.mqtt.internalSecret) {
    logger.warn({ ip: req.ip, path: req.path }, "internal.unauthorized — bad or missing secret");
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  next();
}

// handleSettle
export const handleSettle = async (req: Request, res: Response): Promise<void> => {
  const { transaction_id, terminal_id, student_uid, amount } = req.body as {
    transaction_id?: unknown;
    terminal_id?: unknown;
    student_uid?: unknown;
    amount?: unknown;
  };

  const log = logger.child({ transaction_id, terminal_id, student_uid, amount });

  // Field validation
  if (
    typeof transaction_id !== "string" || transaction_id.trim().length === 0 || transaction_id.length > 64
  ) {
    res.status(400).json({ success: false, message: "transaction_id must be a non-empty string (max 64 chars)" });
    return;
  }

  if (typeof terminal_id !== "string" || terminal_id.trim().length === 0 || terminal_id.length > 20) {
    res.status(400).json({ success: false, message: "terminal_id must be a non-empty string (max 20 chars)" });
    return;
  }

  if (typeof student_uid !== "string" || student_uid.trim().length === 0 || student_uid.length > 20) {
    res.status(400).json({ success: false, message: "student_uid must be a non-empty string (max 20 chars)" });
    return;
  }

  const parsedAmount = typeof amount === "number" ? amount : parseFloat(String(amount));
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ success: false, message: "amount must be a positive number" });
    return;
  }

  log.info("settlement.request_received");

  // Delegate to settlement service
  try {
    const result = await settleRide({
      transaction_id: transaction_id.trim(),
      terminal_id: terminal_id.trim(),
      student_uid: student_uid.trim(),
      amount: parsedAmount,
    });

    switch (result.status) {
      case "SETTLED":
        log.info(result, "settlement.http_response_settled");
        res.status(200).json({
          success: true,
          status: "SETTLED",
          data: {
            studentNewBalance: result.studentNewBalance,
            driverEarned: result.driverEarned,
            platformEarned: result.platformEarned,
          },
        });
        return;

      case "ALREADY_SETTLED":
        log.info("settlement.http_response_already_settled");
        res.status(200).json({
          success: true,
          status: "ALREADY_SETTLED",
          message: "Ride already settled — no action taken",
        });
        return;

      case "INSUFFICIENT_BALANCE":
        log.warn(result, "settlement.http_response_insufficient_balance");
        res.status(402).json({
          success: false,
          status: "INSUFFICIENT_BALANCE",
          message: "Student wallet balance is insufficient for this fare",
          data: {
            availableBalance: result.availableBalance,
            required: result.required,
          },
        });
        return;

      case "STUDENT_NOT_FOUND":
        log.warn("settlement.http_response_student_not_found");
        res.status(404).json({
          success: false,
          status: "STUDENT_NOT_FOUND",
          message: "Student wallet not found",
        });
        return;

      case "TERMINAL_NOT_FOUND":
        log.warn("settlement.http_response_terminal_not_found");
        res.status(404).json({
          success: false,
          status: "TERMINAL_NOT_FOUND",
          message: "Terminal not found",
        });
        return;

      case "NO_ACTIVE_DRIVER":
        log.warn("settlement.http_response_no_active_driver");
        res.status(409).json({
          success: false,
          status: "NO_ACTIVE_DRIVER",
          message: "No driver is currently logged into this terminal",
        });
        return;

      case "DRIVER_NOT_FOUND":
        log.warn("settlement.http_response_driver_not_found");
        res.status(404).json({
          success: false,
          status: "DRIVER_NOT_FOUND",
          message: "Terminal active driver not found or has incorrect role",
        });
        return;

      default: {
        
        // TypeScript exhaustiveness guard
        const _exhaustive: never = result;
        log.error({ result: _exhaustive }, "settlement.unknown_result_status");
        res.status(500).json({ success: false, message: "Internal server error" });
        return;
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err: errMsg }, "settlement.http_unhandled_error");
    res.status(500).json({ success: false, message: "Internal server error during settlement" });
  }
};
