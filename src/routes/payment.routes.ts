import { Router } from "express";
import {
  initializeCheckout,
  getCheckoutStatus,
  getTopupHistory,
  requeryTopup,
} from "../controller/payment.controller.js";
import {
  handlePaymentWebhook,
  handlePayoutWebhook,
} from "../controller/webhook.controller.js";
import {
  authenticateToken,
  requireStudent,
} from "../middleware/auth.middleware.js";
import {
  walletLimiter,
  requeryLimiter,
} from "../middleware/rate-limit.middleware.js";

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
router.get(
  "/history",
  authenticateToken,
  requireStudent,
  walletLimiter,
  getTopupHistory
);
router.post(
  "/requery/:reference",
  authenticateToken,
  requireStudent,
  requeryLimiter,
  requeryTopup
);

export default router;