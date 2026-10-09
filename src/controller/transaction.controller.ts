import type { Response } from "express";
import prisma from "../lib/prisma.js";
import type { AuthenticatedRequest } from "./auth.controller.js";

export const getTransactionHistory = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  const limit = Math.min(
    Math.max(parseInt(req.query.limit as string, 10) || 20, 1),
    100
  );
  const cursor = req.query.cursor as string | undefined;

  const rows = await prisma.transaction.findMany({
    where: { user: { id: req.user!.userId } },
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

  res.status(200).json({
    success: true,
    data: { transactions, nextCursor, hasMore, count: transactions.length },
  });
};
