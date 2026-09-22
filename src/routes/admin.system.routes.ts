import { Router } from "express";
import {
  requireAdminSecret,
  requireCriticalApproval,
  issuePoisonPillHandler,
  broadcastOtaHandler,
  confirmRegistrationHandler,
  monnifyWebhookHandler,
  registerTerminalHandler,
} from "../controller/admin.controller.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.middleware.js";

const router = Router();

router.post(
  "/poison-pill",
  authenticateToken,
  requireAdmin,
  requireAdminSecret,
  requireCriticalApproval,
  issuePoisonPillHandler
);
router.post("/ota", authenticateToken, requireAdmin, requireAdminSecret, broadcastOtaHandler);
router.post(
  "/confirm-registration",
  authenticateToken,
  requireAdmin,
  requireAdminSecret,
  confirmRegistrationHandler
);
router.post(
  "/monnify-webhook",
  authenticateToken,
  requireAdmin,
  requireAdminSecret,
  monnifyWebhookHandler
);
router.post(
  "/terminal/register",
  authenticateToken,
  requireAdmin,
  requireAdminSecret,
  registerTerminalHandler
);

export default router;
