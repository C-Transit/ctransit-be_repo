import type { Response } from "express";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import type { AuthenticatedRequest } from "./auth.controller.js";

export const getTransactionHistory = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { matricNumber: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const limit = Math.min(
      Math.max(parseInt(req.query.limit as string, 10) || 20, 1),
      100
    );
    const cursor = req.query.cursor as string | undefined;

    const rows = await prisma.transaction.findMany({
      where: { student_uid: user.matricNumber },
      select: {
        transaction_id: true,
        amount: true,
        type: true,
        synced_at: true,
        tapped_at: true,
        terminal_id: true,
        location: true,
        card_uid: true,
      },
      orderBy: [{ synced_at: "desc" }, { transaction_id: "desc" }],
      take: limit + 1,
      ...(cursor && { cursor: { transaction_id: cursor }, skip: 1 }),
    });

    const hasMore = rows.length > limit;
    const transactions = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? transactions[transactions.length - 1].transaction_id
      : null;

    return res.status(200).json({
      success: true,
      data: { transactions, nextCursor, hasMore, count: transactions.length },
    });
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : "Unknown error" },
      "transaction.history_error"
    );
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch transaction history" });
  }
};
