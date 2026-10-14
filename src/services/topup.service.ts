import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import { paymentContainer } from "../payments/payment.container.js";
import {
  creditPaymentAttempt,
  hasCrossedAboveThreshold,
} from "./ledger.service.js";
import { sendNotification } from "./notification.service.js";
import { enqueueBroadcast } from "../utils/bridge.js";
import { buildDeltaCommand } from "../utils/parser.js";

const OPEN_STATUSES = ["PENDING", "PROCESSING"] as const;
// An unpaid checkout older than this is shown as EXPIRED. A late success webhook can still credit it.
const EXPIRY_MS = 24 * 60 * 60 * 1000;

type PublicStatus = "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED";

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const isOpen = (status: string) =>
  (OPEN_STATUSES as readonly string[]).includes(status);

// The client sees one "PENDING" for both PENDING and PROCESSING.
const toPublicStatus = (status: string): PublicStatus =>
  isOpen(status) ? "PENDING" : (status as PublicStatus);

const ATTEMPT_SELECT = {
  reference: true,
  amount: true,
  currency: true,
  status: true,
  createdAt: true,
  completedAt: true,
} as const;

interface AttemptRow {
  reference: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
}

function toView(a: AttemptRow) {
  return {
    reference: a.reference,
    amount: Number(a.amount),
    currency: a.currency,
    status: toPublicStatus(a.status),
    canRequery: isOpen(a.status),
    createdAt: a.createdAt,
    completedAt: a.completedAt,
  };
}

const notify = (matric: string, title: string, body: string) =>
  sendNotification(matric, title, body).catch((err: unknown) =>
    logger.warn({ err: errMsg(err) }, "topup.notification_failed — non-fatal")
  );

// Runs AFTER a wallet credit has committed. Shared by the webhook and requery.
// Best-effort: nothing here may undo or fail a completed credit.
export async function runPostCreditEffects(
  matric: string,
  amount: number,
  previousBalance: number,
  newBalance: number
): Promise<void> {
  const log = logger.child({ matric });
  log.info({ previousBalance, newBalance }, "topup.wallet_credited");

  notify(
    matric,
    "Wallet Top-Up Successful",
    `Your CTransit wallet has been credited with ₦${amount.toFixed(
      2
    )}. New balance: ₦${newBalance.toFixed(2)}.`
  );

  if (!hasCrossedAboveThreshold(previousBalance, newBalance)) return;

  try {
    await prisma.blacklist.deleteMany({ where: { student_uid: matric } });
    const card = await prisma.cardMapping.findUnique({
      where: { student_uid: matric },
      select: { card_uid: true },
    });
    if (card) {
      await enqueueBroadcast(buildDeltaCommand("REM", "BL", card.card_uid));
    }
    notify(
      matric,
      "Ride Access Restored",
      `Your balance is now ₦${newBalance.toFixed(
        2
      )}. You can tap your card to ride again.`
    );
  } catch (err) {
    log.error(
      { err: errMsg(err) },
      "topup.blacklist_removal_failed — wallet already credited"
    );
  }
}

export async function listTopups(userId: string, page: number, limit: number) {
  const [total, rows] = await Promise.all([
    prisma.paymentAttempt.count({ where: { userId } }),
    prisma.paymentAttempt.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: ATTEMPT_SELECT,
    }),
  ]);

  return { items: rows.map(toView), page, limit, total };
}

// Asks Kora about an unresolved top-up and applies the verified result.
// Credits go through creditPaymentAttempt, so a webhook and a requery racing
// each other still credit exactly once.
export async function requeryTopupForStudent(userId: string, reference: string) {
  const attempt = await prisma.paymentAttempt.findFirst({
    where: { reference, userId },
    select: ATTEMPT_SELECT,
  });
  if (!attempt) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");

  if (!isOpen(attempt.status)) {
    return {
      ...toView(attempt),
      changed: false,
      message: "This payment is already final.",
    };
  }

  if (!paymentContainer.verifyCharge) throw new Error("CHECKOUT_NOT_SUPPORTED");

  const log = logger.child({ reference, userId });
  const query = await paymentContainer.verifyCharge(reference);
  let pendingMessage = "Payment has not been completed yet.";

  switch (query.status) {
    case "success": {
      if (query.amount === undefined) {
        log.warn("topup.requery_success_without_amount — not crediting");
        throw new Error("VERIFY_UNAVAILABLE");
      }
      const outcome = await creditPaymentAttempt(
        reference,
        query.amount,
        query.currency
      );
      if (outcome.status === "CREDITED") {
        await runPostCreditEffects(
          outcome.matric,
          query.amount,
          outcome.previousBalance,
          outcome.newBalance
        );
      } else if (outcome.status !== "DUPLICATE") {
        log.error(
          { outcome: outcome.status },
          "topup.requery_credit_blocked — needs manual review"
        );
        throw new Error("TOPUP_NEEDS_REVIEW");
      }
      break;
    }

    case "failed":
      await prisma.paymentAttempt.updateMany({
        where: { reference, status: { in: [...OPEN_STATUSES] } },
        data: {
          status: "FAILED",
          failureReason: "Kora reported the charge as failed",
        },
      });
      break;

    case "pending":
    case "not_found":
    case "processing":
      if (Date.now() - attempt.createdAt.getTime() > EXPIRY_MS) {
        await prisma.paymentAttempt.updateMany({
          where: { reference, status: { in: [...OPEN_STATUSES] } },
          data: {
            status: "EXPIRED",
            failureReason: "Checkout was not completed",
          },
        });
      } else if (query.status === "processing") {
        pendingMessage = "Kora is still processing this payment.";
      }
      break;

    default:
      log.warn({ detail: query.message }, "topup.requery_unavailable");
      throw new Error("VERIFY_UNAVAILABLE");
  }

  const fresh = await prisma.paymentAttempt.findFirst({
    where: { reference, userId },
    select: ATTEMPT_SELECT,
  });
  if (!fresh) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");

  const view = toView(fresh);
  const messages: Record<PublicStatus, string> = {
    SUCCESS: "Payment confirmed. Your wallet has been credited.",
    FAILED: "Payment failed.",
    EXPIRED: "Checkout expired. The payment was not completed.",
    CANCELLED: "Payment was cancelled.",
    PENDING: pendingMessage,
  };

  return {
    ...view,
    changed: fresh.status !== attempt.status,
    message: messages[view.status],
  };
}