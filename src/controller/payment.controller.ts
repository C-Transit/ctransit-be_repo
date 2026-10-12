import type { Response } from "express";
import type { AuthenticatedRequest } from "./auth.controller.js";
import { initializeCheckoutForStudent, getCheckoutStatusForStudent } from "../services/payment.service.js";
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
    const known: Record<string, [number, string]> = {
      INVALID_CHECKOUT_AMOUNT: [400, "Amount must be an integer between 150 and 10000 NGN"],
      USER_NOT_FOUND: [404, "User not found"],
      WALLET_NOT_ACTIVATED: [403, "Wallet not activated"],
      CHECKOUT_NOT_SUPPORTED: [501, "Checkout is not supported by the active provider"],
      CHECKOUT_OUTCOME_UNKNOWN: [503, "Payment service is slow to respond. Please try again shortly."],
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