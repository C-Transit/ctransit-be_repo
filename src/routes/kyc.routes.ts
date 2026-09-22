// kyc.routes.ts
import { Router } from "express";
import {
  submitKycHandler,
  getKycStatus,
} from "../controller/kyc.controller.js";
import {
  authenticateToken,
  requireStudent,
} from "../middleware/auth.middleware.js";
import upload from "../middleware/upload.middleware.js";

const router = Router();

// All KYC routes require a valid student JWT
router.use(authenticateToken, requireStudent);

router.post("/submit", upload.single("idCard"), submitKycHandler); 
router.get("/status", getKycStatus);

export default router;
