import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { reconcileStuckWithdrawals } from "../services/driver.service.js";

const router = Router();

function isAuthorized(header: unknown): boolean {
  if (typeof header !== "string") return false;
  const expected = env.admin.secret;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

// POST /api/internal/reconcile-withdrawals
// Protected by a shared secret so an external scheduler can resolve payouts whose
// webhook never arrived. Safe to run repeatedly: every state claim is atomic.
router.post("/reconcile-withdrawals", async (req, res) => {
  if (!isAuthorized(req.headers["x-admin-secret"])) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const summary = await reconcileStuckWithdrawals(15);
    return res.status(200).json({ success: true, data: summary });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "internal.reconcile_withdrawals_failed"
    );
    return res.status(500).json({ success: false, message: "Reconciliation failed" });
  }
});

export default router;
