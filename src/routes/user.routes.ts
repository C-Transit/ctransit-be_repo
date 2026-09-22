import { Router } from "express";
import {
  fetchUserCount,
  fetchAllUsers,
  fetchProfile,
  updateProfile,
  changePassword,
  requestForgotPassword,
  resetForgotPassword,
} from "../controller/user.controller.js";
import {
  authenticateToken,
  requireAdminOrAgent,
} from "../middleware/auth.middleware.js";

const router = Router();

// Public routes
router.post("/forgot-password", requestForgotPassword);
router.post("/reset-password", resetForgotPassword);

// Protected routes
router.use(authenticateToken);

router.get("/count", requireAdminOrAgent, fetchUserCount);
router.get("/", requireAdminOrAgent, fetchAllUsers);
router.get("/myprofile", fetchProfile);
router.patch("/update-profile", updateProfile);
router.patch("/change-password", changePassword);

export default router;
