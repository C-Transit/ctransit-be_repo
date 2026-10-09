import prisma from "../lib/prisma.js";
import env from "../config/env.js";
import logger from "../config/logger.js";

interface CreditResult {
  previousBalance: number;
  newBalance: number;
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
  reference?: string
): Promise<CreditResult | null> {
  const wallet = await prisma.wallet.findUnique({
    where: { student_uid: studentUid },
    select: { balance: true },
  });

  if (!wallet) {
    logger.warn({ studentUid }, "ledger.credit_wallet_not_found");
    return null;
  }

  const txRef =
    reference ??
    `TOPUP-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;
  const previousBalance = wallet.balance.toNumber();

  // Idempotency: a reference that already exists must never be credited twice.
  const existing = await prisma.transaction.findUnique({
    where: { transaction_id: txRef },
    select: { transaction_id: true },
  });
  if (existing) {
    logger.info(
      { studentUid, txRef },
      "ledger.credit_wallet_already_processed — idempotent skip"
    );
    return { previousBalance, newBalance: previousBalance };
  }

  const [updatedWallet] = await prisma.$transaction([
    prisma.wallet.update({
      where: { student_uid: studentUid },
      data: { balance: { increment: amount } },
      select: { balance: true },
    }),
    prisma.transaction.create({
      data: {
        transaction_id: txRef,
        type: "TOPUP",
        terminal_id: "SYSTEM_TERMINAL",
        student_uid: studentUid,
        amount,
      },
    }),
  ]);

  const newBalance = updatedWallet.balance.toNumber();
  logger.info(
    { studentUid, previousBalance, newBalance, amount, reference: txRef },
    "ledger.wallet_credited"
  );

  return { previousBalance, newBalance };
}

export { hasCrossedAboveThreshold, activateWallet, creditWallet };
