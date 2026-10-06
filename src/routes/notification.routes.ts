import { Router } from "express";
import {
  authenticateToken,
  requireStudent,
} from "../middleware/auth.middleware.js";
import notificationController from "../controller/notification.controller.js";

const router = Router();

// Students only — notifications are personal and tied to matricNumber
router.use(authenticateToken, requireStudent);
router.use("/", notificationController);

export default router;
