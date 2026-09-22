import { Router } from "express";
import {
  approveKycHandler,
  rejectKycHandler,
  requireAdminSecret,
} from "../controller/admin.controller.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/approve", authenticateToken, requireAdmin, requireAdminSecret, approveKycHandler);
router.post("/reject", authenticateToken, requireAdmin, requireAdminSecret, rejectKycHandler);

export default router;
