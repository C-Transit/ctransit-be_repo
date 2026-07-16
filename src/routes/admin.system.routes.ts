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

router.use(requireAdminSecret);
router.post("/poison-pill", issuePoisonPillHandler);
router.post("/ota", broadcastOtaHandler);
router.post("/confirm-registration", confirmRegistrationHandler);
router.post("/monnify-webhook", monnifyWebhookHandler);
router.post("/terminal/register", registerTerminalHandler);

export default router;
