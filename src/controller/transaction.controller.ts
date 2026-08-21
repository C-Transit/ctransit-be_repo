// transaction.controller.ts
import type { Response } from "express";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import type { AuthenticatedRequest } from "./auth.controller.js";

export const getTransactionHistory = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Resolve matricNumber from userId — transaction table keys on
    // student_uid (matricNumber), not User.id, to match terminal records.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { matricNumber: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const limit = Math.min(Math.max(isNaN(limitParam) ? 20 : limitParam, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findArgs: any = {
      where: { student_uid: user.matricNumber },
      select: {
        transaction_id: true,
        amount: true,
        type: true,
        synced_at: true,
        terminal_id: true,
      },
      orderBy: { synced_at: "desc" },
      take: limit + 1,
    };

    if (cursor) {
      findArgs.cursor = { transaction_id: cursor };
      findArgs.skip = 1;
    }

    const rows = await prisma.transaction.findMany(findArgs);
    const hasMore = rows.length > limit;
    const transactions = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && transactions.length > 0
        ? transactions[transactions.length - 1].transaction_id
        : null;

    logger.info(
      { studentUid: user.matricNumber, count: transactions.length, hasMore },
      "transaction.history_fetched"
    );

    return res.status(200).json({
      success: true,
      data: {
        transactions,
        nextCursor,
        hasMore,
        count: transactions.length,
      },
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "transaction.history_error");
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transaction history",
    });
  }
};
