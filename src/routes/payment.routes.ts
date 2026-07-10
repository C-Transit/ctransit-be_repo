import { Router } from "express";
import {
  requestVirtualAccount,
  getVirtualAccountDetails,
} from "../controller/payment.controller.js";
import { handlePaymentWebhook } from "../controller/webhook.controller.js";
import {
  authenticateToken,
  requireStudent,
} from "../middleware/auth.middleware.js";

const router = Router();

router.post("/webhook", handlePaymentWebhook);

router.post(
  "/virtual-account",
  authenticateToken,
  requireStudent,
  requestVirtualAccount
);
router.get(
  "/virtual-account",
  authenticateToken,
  requireStudent,
  getVirtualAccountDetails
);

export default router;
