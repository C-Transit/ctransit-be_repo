import type { Request, Response } from "express";
import { paymentContainer } from "../payments/payment.container.js";
import {
  creditPaymentAttempt,
  hasCrossedAboveThreshold,
} from "../services/ledger.service.js";
import { enqueueBroadcast } from "../utils/bridge.js";
import { buildDeltaCommand } from "../utils/parser.js";
import { sendNotification } from "../services/notification.service.js";
import { handleDriverPayoutWebhook } from "../services/driver.service.js";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const notify = (matric: string, title: string, body: string) =>
  sendNotification(matric, title, body).catch((err: unknown) =>
    logger.warn({ err: errMsg(err) }, "webhook.notification_failed — non-fatal")
  );

// Kora signs only the `data` object (HMAC-SHA256).
function isValidSignature(req: Request): boolean {
  const signature = req.headers["x-korapay-signature"];
  const data = req.body?.data;
  const ok =
    typeof signature === "string" &&
    !!data &&
    paymentContainer.verifyWebhook(JSON.stringify(data), signature);
  if (!ok) {
    logger.warn(
      {
        signaturePrefix:
          typeof signature === "string" ? signature.slice(0, 16) : "(empty)",
      },
      "webhook.invalid_signature — rejecting"
    );
  }
  return ok;
}

const invalidSignature = (res: Response) =>
  res
    .status(401)
    .json({
      success: false,
      message: "Cryptographic signature validation failed.",
    });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processPayoutEvent(event: string, data: any, res: Response) {
  const result = await handleDriverPayoutWebhook({
    reference: data.reference || data.transaction_reference,
    koraReference: data.transaction_reference || data.reference,
    event,
    status: data.status || (event.endsWith("success") ? "success" : "failed"),
    fee: data.fee !== undefined ? Number(data.fee) : undefined,
    amount: data.amount !== undefined ? Number(data.amount) : undefined,
    reason: data.reason || data.message || data.failure_reason,
  });
  return res.status(200).json({ success: true, message: result.message });
}

const isPayoutEvent = (event: unknown): event is string =>
  event === "transfer.success" || event === "transfer.failed";

// POST /payments/payout-webhook — driver payouts only.
export const handlePayoutWebhook = async (req: Request, res: Response) => {
  if (!isValidSignature(req)) return invalidSignature(res);
  const { event, data } = req.body;
  if (!isPayoutEvent(event)) {
    return res
      .status(200)
      .json({ success: true, message: "Event type not handled." });
  }
  return processPayoutEvent(event, data, res);
};

// POST /payments/webhook — student checkout payments.
export const handlePaymentWebhook = async (req: Request, res: Response) => {
  if (!isValidSignature(req)) return invalidSignature(res);
  const { event, data } = req.body;

  if (isPayoutEvent(event)) return processPayoutEvent(event, data, res);

  if (event === "charge.failed") {
    if (data.reference) {
      await prisma.paymentAttempt.updateMany({
        where: { reference: data.reference, status: { not: "SUCCESS" } },
        data: {
          status: "FAILED",
          failureReason: data.message || data.reason || "Kora charge failed",
        },
      });
    }
    return res
      .status(200)
      .json({ success: true, message: "Payment failure acknowledged." });
  }

  if (event !== "charge.success") {
    logger.info({ event }, "webhook.unhandled_event_type — acknowledging");
    return res
      .status(200)
      .json({ success: true, message: "Event type not handled." });
  }

  const reference: string | undefined = data.reference;
  const amount = Number(data.amount);
  if (!reference || !(amount > 0)) {
    logger.warn({ reference, amount }, "webhook.invalid_payload");
    return res
      .status(400)
      .json({ success: false, message: "Invalid webhook payload." });
  }

  const log = logger.child({ reference, amount });

  // Any thrown error here becomes a 500, so Kora retries and nothing was committed.
  const outcome = await creditPaymentAttempt(reference, amount, data.currency);

  switch (outcome.status) {
    case "DUPLICATE":
      log.info("webhook.duplicate_reference — already processed");
      return res
        .status(200)
        .json({ success: true, message: "Transaction already acknowledged." });
    case "NOT_FOUND":
      log.error(
        "webhook.unmatched_payment — no PaymentAttempt, needs manual review"
      );
      return res
        .status(404)
        .json({ success: false, message: "Payment attempt not found." });
    case "AMOUNT_MISMATCH":
    case "CURRENCY_MISMATCH":
      log.error(
        { outcome: outcome.status },
        "webhook.payment_mismatch — not credited, needs manual review"
      );
      return res
        .status(400)
        .json({ success: false, message: "Payment amount mismatch." });
    case "NO_WALLET":
      log.error(
        "webhook.wallet_not_found — payment received but wallet missing"
      );
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
  }

  const { matric, previousBalance, newBalance } = outcome;
  log.info({ matric, previousBalance, newBalance }, "webhook.wallet_credited");

  notify(
    matric,
    "Wallet Top-Up Successful",
    `Your CTransit wallet has been credited with ₦${amount.toFixed(
      2
    )}. New balance: ₦${newBalance.toFixed(2)}.`
  );

  if (hasCrossedAboveThreshold(previousBalance, newBalance)) {
    // Post-commit and best-effort. The money is already safe, so nothing below may fail the webhook.
    try {
      await prisma.blacklist.deleteMany({ where: { student_uid: matric } });
      const card = await prisma.cardMapping.findUnique({
        where: { student_uid: matric },
        select: { card_uid: true },
      });
      if (card)
        await enqueueBroadcast(buildDeltaCommand("REM", "BL", card.card_uid));
      notify(
        matric,
        "Ride Access Restored",
        `Your balance is now ₦${newBalance.toFixed(
          2
        )}. You can tap your card to ride again.`
      );
    } catch (err) {
      log.error(
        { err: errMsg(err), matric },
        "webhook.blacklist_removal_failed — wallet already credited"
      );
    }
  }

  return res
    .status(200)
    .json({
      success: true,
      message: `Wallet credited with ₦${amount.toFixed(2)}`,
    });
};
