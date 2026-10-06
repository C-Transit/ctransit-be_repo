import { Router, type Response } from "express";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import {
  raiseDispute,
  getStudentDisputes,
} from "../services/dispute.service.js";

const router = Router();

// POST /api/disputes
// Student raises a dispute against a RIDE transaction.
// Body: { transactionId, description }
router.post(
  "/",
  async (
    req: CustomAuthRequest & {
      body: { transactionId: string; description: string };
    },
    res: Response
  ) => {
    const { transactionId, description } = req.body;

    if (!transactionId || !description) {
      return res
        .status(400)
        .json({ error: "transactionId and description are required" });
    }

    if (description.trim().length < 10) {
      return res.status(400).json({
        error: "description must be at least 10 characters",
      });
    }

    try {
      const dispute = await raiseDispute(
        req.user!.userId,
        transactionId,
        description
      );
      return res.status(201).json({ success: true, dispute });
    } catch (error) {
      if (error instanceof Error) {
        switch (error.message) {
          case "STUDENT_NOT_FOUND":
            return res.status(404).json({ error: "Student account not found" });
          case "TRANSACTION_NOT_FOUND":
            return res.status(404).json({ error: "Transaction not found" });
          case "TRANSACTION_NOT_OWNED":
            // Return 404 not 403 — don't confirm the transaction exists
            return res.status(404).json({ error: "Transaction not found" });
          case "ONLY_RIDE_TRANSACTIONS_DISPUTABLE":
            return res.status(400).json({
              error: "Only RIDE transactions can be disputed",
            });
          case "DISPUTE_ALREADY_ACTIVE":
            return res.status(409).json({
              error: "An open dispute already exists for this transaction",
            });
        }
      }

      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "dispute.route_raise_error");
      return res.status(500).json({ error: "Failed to raise dispute" });
    }
  }
);

// GET /api/disputes
// Returns the authenticated student's own disputes
// with the disputed transaction summary inline.
router.get("/", async (req: CustomAuthRequest, res: Response) => {
  try {
    const disputes = await getStudentDisputes(req.user!.userId);
    return res.status(200).json({ success: true, disputes });
  } catch (error) {
    if (error instanceof Error && error.message === "STUDENT_NOT_FOUND") {
      return res.status(404).json({ error: "Student account not found" });
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "dispute.route_list_error");
    return res.status(500).json({ error: "Failed to fetch disputes" });
  }
});

export default router;
