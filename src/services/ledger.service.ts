"use strict";

import prisma from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";
import logger from "../config/logger.js";
import env from "../config/env.js";


// Support both standard PrismaClient and Transactional Client
type DbClient = typeof prisma | Prisma.TransactionClient;

interface DeductionResult {
  newBalance: number | null;
  walletFound: boolean;
}

interface CreditResult {
  previousBalance: number;
  newBalance: number;
}

async function deductFare(
  studentUid: string,
  amount: number,
  transactionId: string,
  dbClient: DbClient = prisma
): Promise<DeductionResult> {
  const childLogger = logger.child({ transactionId, studentUid, amount });
  const wallet = await dbClient.wallet.findUnique({
    where: { student_uid: studentUid },
    select: { balance: true },
  });

  if (!wallet) {
    childLogger.warn("ledger.wallet_not_found — skipping deduction");
    return { newBalance: null, walletFound: false };
  }

  const updatedWallet = await dbClient.wallet.update({
    where: { student_uid: studentUid },
    data: { balance: { decrement: amount } },
    select: { balance: true },
  });

  const newBalance = parseFloat(updatedWallet.balance.toString());
  childLogger.info(
    { previousBalance: parseFloat(wallet.balance.toString()), newBalance },
    "ledger.fare_deducted"
  );
  return { newBalance, walletFound: true };
}

function isBelowThreshold(balance: number): boolean {
  return balance < env.ledger.baseFare;
}

function hasCrossedAboveThreshold(
  previousBalance: number,
  newBalance: number
): boolean {
  return (
    previousBalance < env.ledger.baseFare && newBalance >= env.ledger.baseFare
  );
}

async function activateWallet(studentUid: string): Promise<void> {
  await prisma.wallet.upsert({
    where: { student_uid: studentUid },
    update: { is_linked: true },
    create: { student_uid: studentUid, balance: 0, is_linked: true },
  });
  logger.info({ studentUid }, "ledger.wallet_activated");
}

async function creditWallet(
  studentUid: string,
  amount: number,
  reference?: string, // <-- new: optional transaction reference
  dbClient = prisma
): Promise<CreditResult | null> {
  const wallet = await dbClient.wallet.findUnique({
    where: { student_uid: studentUid },
    select: { balance: true },
  });

  if (!wallet) {
    logger.warn({ studentUid }, "ledger.credit_wallet_not_found");
    return null;
  }

  // Generate a reference if not provided
  const txRef =
    reference ??
    `TOPUP-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;

  // Perform the credit and create transaction in a single Prisma transaction
  const [updatedWallet] = await dbClient.$transaction([
    dbClient.wallet.update({
      where: { student_uid: studentUid },
      data: { balance: { increment: amount } },
      select: { balance: true },
    }),
    dbClient.transaction.create({
      data: {
        transaction_id: txRef,
        type: "TOPUP",
        terminal_id: "SYSTEM_TERMINAL", // <-- use a dedicated system terminal
        student_uid: studentUid,
        amount: amount,
        driver_uid: null, // not applicable for top-ups
        synced_at: new Date(),
      },
    }),
  ]);

  const previousBalance = parseFloat(wallet.balance.toString());
  const newBalance = parseFloat(updatedWallet.balance.toString());

  logger.info(
    { studentUid, previousBalance, newBalance, amount, reference: txRef },
    "ledger.wallet_credited"
  );

  return { previousBalance, newBalance };
}

export {
  deductFare,
  isBelowThreshold,
  hasCrossedAboveThreshold,
  activateWallet,
  creditWallet,
  prisma,
};
