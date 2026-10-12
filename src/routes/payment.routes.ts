import { Router } from "express";
import {
  initializeCheckout,
  getCheckoutStatus,
} from "../controller/payment.controller.js";
import {
  handlePaymentWebhook,
  handlePayoutWebhook,
} from "../controller/webhook.controller.js";
import {
  authenticateToken,
  requireStudent,
} from "../middleware/auth.middleware.js";

const router = Router();

router.post("/webhook", handlePaymentWebhook); // student checkout credits
router.post("/payout-webhook", handlePayoutWebhook); // driver payout confirmations

router.post(
  "/initialize",
  authenticateToken,
  requireStudent,
  initializeCheckout
);
router.get(
  "/status/:reference",
  authenticateToken,
  requireStudent,
  getCheckoutStatus
);

export default router;
