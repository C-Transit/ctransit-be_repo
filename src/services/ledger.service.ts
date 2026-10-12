import prisma from "../lib/prisma.js";
import env from "../config/env.js";

export type CreditOutcome =
  | {
      status: "CREDITED";
      matric: string;
      previousBalance: number;
      newBalance: number;
    }
  | {
      status:
        | "DUPLICATE"
        | "NOT_FOUND"
        | "AMOUNT_MISMATCH"
        | "CURRENCY_MISMATCH"
        | "NO_WALLET";
    };

function hasCrossedAboveThreshold(
  previousBalance: number,
  newBalance: number
): boolean {
  return (
    previousBalance < env.ledger.baseFare && newBalance >= env.ledger.baseFare
  );
}

// Credits the wallet for a checkout payment and finalizes its PaymentAttempt in ONE transaction.
async function creditPaymentAttempt(
  reference: string,
  paidAmount: number,
  currency?: string
): Promise<CreditOutcome> {
  return prisma.$transaction(async (tx): Promise<CreditOutcome> => {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { reference },
      select: {
        amount: true,
        currency: true,
        user: { select: { matricNumber: true } },
      },
    });
    if (!attempt) return { status: "NOT_FOUND" };
    if (!attempt.amount.equals(paidAmount))
      return { status: "AMOUNT_MISMATCH" };
    if (currency && currency.toUpperCase() !== attempt.currency.toUpperCase()) {
      return { status: "CURRENCY_MISMATCH" };
    }

    const matric = attempt.user.matricNumber;
    const wallet = await tx.wallet.findUnique({
      where: { student_uid: matric },
      select: { student_uid: true },
    });
    if (!wallet) return { status: "NO_WALLET" };

    // Claim the attempt. A concurrent or repeated webhook finds count 0.
    const claimed = await tx.paymentAttempt.updateMany({
      where: { reference, status: { not: "SUCCESS" } },
      data: {
        status: "SUCCESS",
        completedAt: new Date(),
        providerReference: reference,
        failureReason: null,
      },
    });
    if (claimed.count === 0) return { status: "DUPLICATE" };

    const updated = await tx.wallet.update({
      where: { student_uid: matric },
      data: { balance: { increment: paidAmount } },
      select: { balance: true },
    });
    await tx.transaction.create({
      data: {
        transaction_id: reference,
        type: "TOPUP",
        terminal_id: "SYSTEM_TERMINAL",
        student_uid: matric,
        amount: paidAmount,
      },
    });

    return {
      status: "CREDITED",
      matric,
      newBalance: updated.balance.toNumber(),
      previousBalance: updated.balance.minus(paidAmount).toNumber(),
    };
  });
}

export { hasCrossedAboveThreshold, creditPaymentAttempt };
