import { Router } from "express";
import {
  requireAdminSecret,
  issuePoisonPillHandler,
  broadcastOtaHandler,
  confirmRegistrationHandler,
  monnifyWebhookHandler,
  registerTerminalHandler,
} from "../controller/admin.controller.js";

const router = Router();

router.post("/poison-pill", requireAdminSecret, issuePoisonPillHandler);
router.post("/ota", requireAdminSecret, broadcastOtaHandler);
router.post("/confirm-registration", requireAdminSecret, confirmRegistrationHandler);
router.post("/monnify-webhook", requireAdminSecret, monnifyWebhookHandler);
router.post("/terminal/register", requireAdminSecret, registerTerminalHandler);

export default router;
