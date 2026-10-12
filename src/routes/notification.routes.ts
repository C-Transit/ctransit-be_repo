import { Router } from "express";
import { authenticateToken } from "../middleware/auth.middleware.js";
import type { CustomAuthRequest } from "../middleware/auth.middleware.js";
import notificationController from "../controller/notification.controller.js";

const router = Router();

// Students and drivers: notifications are personal and keyed by matricNumber.
router.use(authenticateToken, (req: CustomAuthRequest, res, next) => {
  if (req.user?.role !== "STUDENT" && req.user?.role !== "DRIVER") {
    return res.status(403).json({ error: "Student or driver access required" });
  }
  next();
});
router.use("/", notificationController);

export default router;