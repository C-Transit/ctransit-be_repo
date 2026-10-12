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
  getCardLinkStatus,
} from "../controller/auth.controller.js";
import { authenticateToken, requireStudent } from "../middleware/auth.middleware.js";

const router = Router();

// Student auth
router.post("/register", registerStudent);
router.post("/verify-otp", verifyOTP);
router.post("/resend-otp", resendOTP);
router.post("/login", loginStudent);
router.post("/logout", logoutStudent);
router.post("/refresh", refreshAccessToken); // no auth: the refresh token is self-validating
router.post("/confirm-card", authenticateToken, requireStudent, confirmCard);
router.get("/card-link-status", authenticateToken, requireStudent, getCardLinkStatus);

// Admin auth (role is enforced against the DB in loginAdmin)
router.post("/admin/login", loginAdmin);

// Agents log in at /api/agents/login (see agent.routes.ts)

export default router;