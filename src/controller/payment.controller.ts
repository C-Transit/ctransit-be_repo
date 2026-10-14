import type { Response } from "express";
import type { AuthenticatedRequest } from "./auth.controller.js";
import { initializeCheckoutForStudent, getCheckoutStatusForStudent } from "../services/payment.service.js";
import { listTopups, requeryTopupForStudent } from "../services/topup.service.js";
import logger from "../config/logger.js";

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export const initializeCheckout = async (req: AuthenticatedRequest, res: Response) => {
  const amount = req.body?.amount;
  if (typeof amount !== "number") {
    return res.status(400).json({ success: false, message: "Amount must be a number" });
  }

  try {
    const result = await initializeCheckoutForStudent(req.user!.userId, amount);
    return res.status(200).json({
      success: true,
      data: { reference: result.reference, checkoutUrl: result.checkoutUrl, status: result.status },
    });
  } catch (error) {
    const code = message(error, "Checkout initialization failed");

    // Outcome unknown: Kora may have created the checkout. Return the reference so the
    // client can poll GET /payments/status/:reference rather than starting a second payment.
    if (code === "CHECKOUT_OUTCOME_UNKNOWN") {
      const reference = (error as { reference?: string }).reference;
      return res.status(503).json({
        success: false,
        message: "Payment service is slow to respond. Check the payment status before trying again.",
        data: reference ? { reference, status: "PENDING" } : undefined,
      });
    }

    const known: Record<string, [number, string]> = {
      INVALID_CHECKOUT_AMOUNT: [400, "Amount must be an integer between 150 and 10000 NGN"],
      USER_NOT_FOUND: [404, "User not found"],
      WALLET_NOT_ACTIVATED: [403, "Wallet not activated"],
      CHECKOUT_NOT_SUPPORTED: [501, "Checkout is not supported by the active provider"],
    };
    if (known[code]) return res.status(known[code][0]).json({ success: false, message: known[code][1] });

    logger.error({ err: code }, "payment.checkout_initialization_error");
    return res.status(502).json({ success: false, message: "Unable to initialize payment checkout" });
  }
};

export const getCheckoutStatus = async (req: AuthenticatedRequest, res: Response) => {
  const reference = req.params.reference;
  if (typeof reference !== "string" || !reference) {
    return res.status(400).json({ success: false, message: "Payment reference is required" });
  }

  try {
    const data = await getCheckoutStatusForStudent(req.user!.userId, reference);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    if (message(error, "") === "PAYMENT_ATTEMPT_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Payment attempt not found" });
    }
    logger.error({ err: message(error, "Unknown error") }, "payment.checkout_status_error");
    return res.status(500).json({ success: false, message: "Unable to retrieve payment status" });
  }
};

// GET /payments/history?page=1&limit=20 — the student's own top-ups, newest first.
export const getTopupHistory = async (req: AuthenticatedRequest, res: Response) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));

  try {
    const data = await listTopups(req.user!.userId, page, limit);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    logger.error({ err: message(error, "Unknown error") }, "payment.history_error");
    return res.status(500).json({ success: false, message: "Unable to retrieve payment history" });
  }
};

// POST /payments/requery/:reference — verifies an unresolved top-up with Kora and applies the result.
export const requeryTopup = async (req: AuthenticatedRequest, res: Response) => {
  const reference = req.params.reference;
  if (typeof reference !== "string" || !reference) {
    return res.status(400).json({ success: false, message: "Payment reference is required" });
  }

  try {
    const data = await requeryTopupForStudent(req.user!.userId, reference);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const code = message(error, "Unknown error");
    const known: Record<string, [number, string]> = {
      PAYMENT_ATTEMPT_NOT_FOUND: [404, "Payment attempt not found"],
      VERIFY_UNAVAILABLE: [503, "We could not check this payment right now. Please try again shortly."],
      TOPUP_NEEDS_REVIEW: [409, "We could not confirm this payment automatically. Contact support with your reference."],
      CHECKOUT_NOT_SUPPORTED: [501, "Payment checks are not supported by the active provider"],
    };
    if (known[code]) return res.status(known[code][0]).json({ success: false, message: known[code][1] });

    logger.error({ err: code }, "payment.requery_error");
    return res.status(500).json({ success: false, message: "Unable to check payment status" });
  }
};