import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import logger from "../config/logger.js";
import env from "../config/env.js";
import { settleRide } from "../services/settlement.service.js";

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function requireInternalSecret(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers["x-internal-secret"];

  if (typeof provided !== "string" || !safeEqual(provided, env.mqtt.internalSecret)) {
    logger.warn({ ip: req.ip, path: req.path }, "internal.unauthorized — bad or missing secret");
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  next();
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
};

const FAILURES = {
  TERMINAL_NOT_FOUND: [404, "Terminal not found"],
  STUDENT_NOT_FOUND: [404, "Student wallet not found"],
  NO_ACTIVE_DRIVER: [409, "No driver is currently logged into this terminal"],
  DRIVER_NOT_FOUND: [404, "Terminal active driver not found or has incorrect role"],
} as const;

export const handleSettle = async (req: Request, res: Response): Promise<void> => {
  const { transaction_id, terminal_id, student_uid, amount } = req.body ?? {};

  const txId = clean(transaction_id, 64);
  const terminalId = clean(terminal_id, 20);
  const studentUid = clean(student_uid, 20);
  const parsedAmount = typeof amount === "number" || typeof amount === "string" ? Number(amount) : NaN;

  if (!txId || !terminalId || !studentUid) {
    res.status(400).json({
      success: false,
      message: "transaction_id (max 64), terminal_id (max 20) and student_uid (max 20) must be non-empty strings",
    });
    return;
  }

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ success: false, message: "amount must be a positive number" });
    return;
  }

  const log = logger.child({ transaction_id: txId, terminal_id: terminalId, student_uid: studentUid, amount: parsedAmount });

  try {
    const result = await settleRide({
      transaction_id: txId,
      terminal_id: terminalId,
      student_uid: studentUid,
      amount: parsedAmount,
    });

    if (result.status === "SETTLED" || result.status === "ALREADY_SETTLED") {
      log.info(result, "settlement.result");
    } else {
      log.warn(result, "settlement.result");
    }

    if (result.status === "SETTLED") {
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
    }

    if (result.status === "ALREADY_SETTLED") {
      res.status(200).json({
        success: true,
        status: "ALREADY_SETTLED",
        message: "Ride already settled — no action taken",
      });
      return;
    }

    if (result.status === "INSUFFICIENT_BALANCE") {
      res.status(402).json({
        success: false,
        status: "INSUFFICIENT_BALANCE",
        message: "Student wallet balance is insufficient for this fare",
        data: { availableBalance: result.availableBalance, required: result.required },
      });
      return;
    }

    const [code, message] = FAILURES[result.status];
    res.status(code).json({ success: false, status: result.status, message });
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "settlement.http_unhandled_error");
    res.status(500).json({ success: false, message: "Internal server error during settlement" });
  }
};