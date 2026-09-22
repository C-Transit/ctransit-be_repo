import { Router } from "express";
import { getTransactionHistory } from "../controller/transaction.controller.js";
import {
  authenticateToken,
  requireStudent,
} from "../middleware/auth.middleware.js";

const router = Router();

// Protect this route so only authenticated students can hit it
router.get("/history", authenticateToken, requireStudent, getTransactionHistory);

export default router;
