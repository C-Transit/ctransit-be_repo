// src/routes/auth.routes.ts
import { Router } from "express";
import {
  registerStudent,
  verifyOTP,
  resendOTP,
  loginStudent,
  loginAdmin,
  logoutStudent,
  confirmCard,
  refreshAccessToken,
} from "../controller/auth.controller.js";
import agentRouter from "./agent.routes.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

const router = Router();

// ── Student auth ───────────────────────────────────────────────────────────
router.post("/register", registerStudent);
router.post("/verify-otp", verifyOTP);
router.post("/resend-otp", resendOTP);
router.post("/login", loginStudent);
router.post("/logout", logoutStudent);
router.post("/refresh", refreshAccessToken); // No auth required — token is self-validating
router.post("/confirm-card", authenticateToken, confirmCard);

// ── Admin auth ─────────────────────────────────────────────────────────────
// Separate route — bypasses institution email check, role-guards at DB level
router.post("/admin/login", loginAdmin);

// ── Agent auth ─────────────────────────────────────────────────────────────
// Agents do not self-register — accounts are created by admin only
router.use("/agent", agentRouter);

export default router;
