import { Router, type Response } from "express";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import { raiseDispute, getStudentDisputes } from "../services/dispute.service.js";

const router = Router();

type ErrorTable = Record<string, [status: number, message: string]>;

function fail(res: Response, error: unknown, table: ErrorTable, event: string, fallback: string) {
  const code = error instanceof Error ? error.message : "";
  const known = table[code];
  if (known) return res.status(known[0]).json({ error: known[1] });

  logger.error({ err: code || "Unknown error" }, event);
  return res.status(500).json({ error: fallback });
}

const STUDENT_NOT_FOUND: ErrorTable = { STUDENT_NOT_FOUND: [404, "Student account not found"] };

// POST /api/disputes { transactionId, description }: a student disputes one of their RIDE transactions.
router.post("/", async (req: CustomAuthRequest, res: Response) => {
  const { transactionId, description } = req.body ?? {};

  if (typeof transactionId !== "string" || typeof description !== "string" || !transactionId || !description) {
    return res.status(400).json({ error: "transactionId and description are required" });
  }
  const text = description.trim();
  if (text.length < 10) return res.status(400).json({ error: "description must be at least 10 characters" });
  if (text.length > 1000) return res.status(400).json({ error: "description must be at most 1000 characters" });

  try {
    const dispute = await raiseDispute(req.user!.userId, transactionId, text);
    return res.status(201).json({ success: true, dispute });
  } catch (error) {
    return fail(
      res,
      error,
      {
        ...STUDENT_NOT_FOUND,
        TRANSACTION_NOT_FOUND: [404, "Transaction not found"],
        // 404, not 403: don't confirm that someone else's transaction exists
        TRANSACTION_NOT_OWNED: [404, "Transaction not found"],
        ONLY_RIDE_TRANSACTIONS_DISPUTABLE: [400, "Only RIDE transactions can be disputed"],
        DISPUTE_ALREADY_ACTIVE: [409, "An open dispute already exists for this transaction"],
      },
      "dispute.route_raise_error",
      "Failed to raise dispute"
    );
  }
});

// GET /api/disputes: the student's own disputes, with the disputed transaction summary.
router.get("/", async (req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, disputes: await getStudentDisputes(req.user!.userId) });
  } catch (error) {
    return fail(res, error, STUDENT_NOT_FOUND, "dispute.route_list_error", "Failed to fetch disputes");
  }
});

export default router;