import type { Request, Response } from "express";
import { paymentContainer } from "../payments/payment.container.js";
import {
  creditWallet,
  hasCrossedAboveThreshold,
} from "../services/ledger.service.js";
import {
  getRedisClient,
  cacheKeys,
  WEBHOOK_DEDUPE_TTL,
} from "../config/redis.js";
import { enqueueBroadcast } from "../utils/bridge.js";
import { buildDeltaCommand } from "../utils/parser.js";
import { sendNotification } from "../services/notification.service.js";
import { handleDriverPayoutWebhook } from "../services/driver.service.js";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";

const processedTransactions = new Set<string>();

type WebhookRequest = Request & { rawBody?: string };

/**
 * Build the list of payload candidates that KORA might be signing.
 *
 * Empirically confirmed (2026-09-25): KORA signs ONLY the `data` object
 * with HMAC-SHA256 — NOT the full request body. We still compute the
 * full-body and raw-body candidates as defensive fallbacks in case
 * KORA changes their signing behavior or a different provider is wired in.
 */
function buildSignatureCandidates(req: WebhookRequest): string[] {
  const candidates: string[] = [];

  // 1. data-object only (KORA — confirmed working)
  if (req.body && typeof req.body === "object" && req.body.data !== undefined) {
    try {
      candidates.push(JSON.stringify(req.body.data));
    } catch {
      // ignore malformed
    }
  }

  // 2. full parsed body re-serialized (fallback for other providers)
  if (req.body && typeof req.body === "object") {
    try {
      candidates.push(JSON.stringify(req.body));
    } catch {
      // ignore
    }
  }

  // 3. raw body bytes (most reliable when raw-body capture is wired up)
  if (typeof req.rawBody === "string" && req.rawBody.length > 0) {
    candidates.push(req.rawBody);
  }

  return Array.from(new Set(candidates));
}

export const handlePaymentWebhook = async (
  req: WebhookRequest,
  res: Response
) => {
  // ─────────────────────────────────────────────
  // Step 1: Verify webhook signature
  // ─────────────────────────────────────────────
  const signature = (req.headers["x-korapay-signature"] ||
    req.headers["fincra-signature"] ||
    "") as string;

  const candidates = buildSignatureCandidates(req);
  const isValid = candidates.some((c) =>
    paymentContainer.verifyWebhook(c, signature)
  );

  if (!isValid) {
    logger.warn(
      {
        signaturePrefix: signature ? signature.slice(0, 16) : "(empty)",
        candidateCount: candidates.length,
      },
      "webhook.invalid_signature — rejecting"
    );
    return res.status(401).json({
      success: false,
      message: "Cryptographic signature validation failed.",
    });
  }

  // ─────────────────────────────────────────────
  // Step 2: Normalize payload across providers
  // ─────────────────────────────────────────────
  const { event, eventType, data, eventData } = req.body;
  const currentEvent = event || eventType;
  const payloadData = data || eventData;

  const chargeReference =
    payloadData?.reference || payloadData?.transactionReference;
  const isFailedChargeEvent =
    currentEvent === "charge.failed" ||
    currentEvent === "charge.failure" ||
    currentEvent === "transaction.failed";

  if (isFailedChargeEvent && chargeReference) {
    await prisma.paymentAttempt.updateMany({
      where: { reference: chargeReference, status: { not: "SUCCESS" } },
      data: {
        status: "FAILED",
        failureReason:
          payloadData?.message || payloadData?.reason || "Kora charge failed",
      },
    });
    return res
      .status(200)
      .json({ success: true, message: "Payment failure acknowledged." });
  }

  // Check for payout / transfer events first
  const isPayoutEvent =
    currentEvent === "transfer.success" ||
    currentEvent === "transfer.failed" ||
    currentEvent === "payout.success" ||
    currentEvent === "payout.failed" ||
    currentEvent === "disbursement.success" ||
    currentEvent === "disbursement.failed";

  if (isPayoutEvent) {
    const pReference =
      payloadData?.reference ||
      payloadData?.transaction_reference ||
      payloadData?.transactionReference;
    const pKoraRef =
      payloadData?.transaction_reference || payloadData?.reference;
    const pStatus =
      payloadData?.status ||
      (currentEvent.includes("success") ? "success" : "failed");
    const pFee =
      payloadData?.fee !== undefined
        ? parseFloat(payloadData.fee.toString())
        : undefined;
    const pAmount =
      payloadData?.amount !== undefined
        ? parseFloat(payloadData.amount.toString())
        : undefined;
    const pReason =
      payloadData?.reason ||
      payloadData?.message ||
      payloadData?.failure_reason;

    const result = await handleDriverPayoutWebhook({
      reference: pReference,
      koraReference: pKoraRef,
      event: currentEvent,
      status: pStatus,
      fee: pFee,
      amount: pAmount,
      reason: pReason,
    });

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  }

  // Only process successful charge events
  if (
    currentEvent !== "charge.success" &&
    currentEvent !== "SUCCESSFUL_TRANSACTION"
  ) {
    logger.info(
      { currentEvent },
      "webhook.unhandled_event_type — acknowledging"
    );
    return res.status(200).json({
      success: true,
      message: "Event type not handled.",
    });
  }

  // ─────────────────────────────────────────────
  // Step 3: Extract fields
  // ─────────────────────────────────────────────
  const txReference =
    payloadData?.reference || payloadData?.transactionReference;
  const studentEmail = payloadData?.customer?.email;
  const accountRef =
    payloadData?.account_reference ||
    payloadData?.virtual_bank_account_details?.account_reference;
  const vAccountNumber =
    payloadData?.virtual_bank_account_details?.virtual_bank_account_number;
  const depositAmount = parseFloat(
    payloadData?.amount || payloadData?.amountPaid || "0"
  );

  // Minimal hard requirements: reference + valid amount.
  // Everything else can be resolved below.
  if (!txReference || isNaN(depositAmount) || depositAmount <= 0) {
    logger.warn(
      { txReference, studentEmail, accountRef, vAccountNumber, depositAmount },
      "webhook.invalid_payload — missing reference or amount"
    );
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload.",
    });
  }

  // Look up the payment attempt FIRST. This is the primary way we link a
  // checkout-session webhook back to a user — the reference we generated
  // at /initialize time is the key.
  const paymentAttempt = await prisma.paymentAttempt.findUnique({
    where: { reference: txReference },
    select: { userId: true, amount: true, status: true },
  });

  // Now decide if we have any path to resolve the student.
  const canResolveUser =
    !!paymentAttempt || !!studentEmail || !!accountRef || !!vAccountNumber;

  if (!canResolveUser) {
    logger.warn(
      { txReference, studentEmail, accountRef, vAccountNumber, depositAmount },
      "webhook.invalid_payload — no resolution path to a user"
    );
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload.",
    });
  }

  if (paymentAttempt && Number(paymentAttempt.amount) !== depositAmount) {
    logger.warn(
      {
        txReference,
        expectedAmount: Number(paymentAttempt.amount),
        receivedAmount: depositAmount,
      },
      "webhook.amount_mismatch"
    );
    return res
      .status(400)
      .json({ success: false, message: "Payment amount mismatch." });
  }

  const log = logger.child({
    txReference,
    studentEmail,
    accountRef,
    depositAmount,
  });

  // ─────────────────────────────────────────────
  // Step 4: Idempotency check (Redis hot path + persistent DB verification)
  // ─────────────────────────────────────────────
  let redisDuplicate: boolean;
  try {
    const redis = getRedisClient();
    const dedupeKey = cacheKeys.webhookDedup(txReference);
    const redisResult = await redis.set(
      dedupeKey,
      "1",
      "EX",
      WEBHOOK_DEDUPE_TTL,
      "NX"
    );
    redisDuplicate = redisResult === null;
  } catch {
    redisDuplicate = false;
  }

  const existingTx = await prisma.transaction.findUnique({
    where: { transaction_id: txReference },
  });

  if (existingTx || processedTransactions.has(txReference) || redisDuplicate) {
    processedTransactions.add(txReference);
    log.info("webhook.duplicate_reference — already processed");
    return res.status(200).json({
      success: true,
      message: "Transaction already acknowledged.",
    });
  }

  // ─────────────────────────────────────────────
  // Step 5: Resolve student from paymentAttempt, email, or virtual account ref
  // ─────────────────────────────────────────────
  let user = paymentAttempt
    ? await prisma.user.findUnique({
        where: { id: paymentAttempt.userId },
        select: { matricNumber: true },
      })
    : null;

  if (!user && studentEmail) {
    user = await prisma.user.findUnique({
      where: { email: studentEmail.toLowerCase() },
      select: { matricNumber: true },
    });
  }

  if (
    !user &&
    accountRef &&
    typeof accountRef === "string" &&
    accountRef.startsWith("CTRANSIT-")
  ) {
    const matricFromRef = accountRef.replace("CTRANSIT-", "").trim();
    user = await prisma.user.findUnique({
      where: { matricNumber: matricFromRef },
      select: { matricNumber: true },
    });
  }

  if (!user && vAccountNumber) {
    const wallet = await prisma.wallet.findFirst({
      where: { v_account_number: String(vAccountNumber) },
      select: { student_uid: true },
    });
    if (wallet) {
      user = { matricNumber: wallet.student_uid };
    }
  }

  if (!user) {
    log.warn("webhook.student_not_found");
    return res.status(404).json({
      success: false,
      message: "Student not found.",
    });
  }

  // ─────────────────────────────────────────────
  // Step 6: Credit wallet
  // ─────────────────────────────────────────────
  try {
    const result = await creditWallet(
      user.matricNumber,
      depositAmount,
      txReference
    );

    if (!result) {
      log.warn("webhook.wallet_not_found");
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const { previousBalance, newBalance } = result;

    if (paymentAttempt) {
      await prisma.paymentAttempt.update({
        where: { reference: txReference },
        data: {
          status: "SUCCESS",
          completedAt: new Date(),
          providerReference: txReference,
        },
      });
    }

    // Step 7: Mark as processed
    processedTransactions.add(txReference);

    log.info({ previousBalance, newBalance }, "webhook.wallet_credited");

    // Step 8: Notify student
    sendNotification(
      user.matricNumber,
      "Wallet Top-Up Successful",
      `Your CTransit wallet has been credited with ₦${depositAmount.toFixed(
        2
      )}. New balance: ₦${newBalance.toFixed(2)}.`
    ).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ err: errMsg }, "webhook.notification_failed — non-fatal");
    });

    // Step 9: Remove from blacklist if threshold crossed
    if (hasCrossedAboveThreshold(previousBalance, newBalance)) {
      const cardMap = await prisma.cardMapping.findUnique({
        where: { student_uid: user.matricNumber },
        select: { card_uid: true },
      });

      if (cardMap) {
        const removeBlCmd = buildDeltaCommand("REM", "BL", cardMap.card_uid);
        await enqueueBroadcast(removeBlCmd);
        log.info({ removeBlCmd }, "webhook.blacklist_removal_broadcast_queued");
      } else {
        log.warn(
          { matricNumber: user.matricNumber },
          "webhook.no_card_found_for_removal"
        );
      }

      await prisma.blacklist.deleteMany({
        where: { student_uid: user.matricNumber },
      });

      sendNotification(
        user.matricNumber,
        "Ride Access Restored",
        `Your balance is now ₦${newBalance.toFixed(
          2
        )}. You can tap your card to ride again.`
      ).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ err: errMsg }, "webhook.blacklist_notification_failed");
      });

      log.info(
        { matricNumber: user.matricNumber },
        "webhook.blacklist_removed"
      );
    }

    return res.status(200).json({
      success: true,
      message: `Wallet credited with ₦${depositAmount.toFixed(2)}`,
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    log.error({ err: errMessage }, "webhook.ledger_update_failed");
    return res.status(500).json({
      success: false,
      message: "Internal ledger error.",
    });
  }
};
