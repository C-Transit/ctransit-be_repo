import type { Request, Response } from "express";
import { paymentContainer } from "../payments/payment.container.js";
import {
  creditWallet,
  hasCrossedAboveThreshold,
} from "../services/ledger.service.js";
import { enqueueBroadcast } from "../utils/bridge.js";
import { buildDeltaCommand } from "../utils/parser.js";
import { sendNotification } from "../services/notification.service.js";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";

const processedTransactions = new Set<string>();

export const handlePaymentWebhook = async (req: Request, res: Response) => {
  // Step 1: Verify webhook signature 
  const signature = (req.headers["x-korapay-signature"] ||
    req.headers["fincra-signature"] ||
    "") as string;

  const rawBody = JSON.stringify(req.body);
  const isValid = paymentContainer.verifyWebhook(rawBody, signature);

  if (!isValid) {
    logger.warn("webhook.invalid_signature — rejecting");
    return res.status(401).json({
      success: false,
      message: "Cryptographic signature validation failed.",
    });
  }

  // Step 2: Normalize payload across providers 
  const { event, eventType, data, eventData } = req.body;
  const currentEvent = event || eventType;
  const payloadData = data || eventData;

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

  //  Step 3: Extract fields 
  const txReference =
    payloadData?.reference || payloadData?.transactionReference;
  const studentEmail = payloadData?.customer?.email;
  const depositAmount = parseFloat(
    payloadData?.amount || payloadData?.amountPaid || "0"
  );

  if (
    !txReference ||
    !studentEmail ||
    isNaN(depositAmount) ||
    depositAmount <= 0
  ) {
    logger.warn(
      { txReference, studentEmail, depositAmount },
      "webhook.invalid_payload — missing required fields"
    );
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload.",
    });
  }

  const log = logger.child({ txReference, studentEmail, depositAmount });

  //  Step 4: Idempotency check 
  if (processedTransactions.has(txReference)) {
    log.info("webhook.duplicate_reference — already processed");
    return res.status(200).json({
      success: true,
      message: "Transaction already acknowledged.",
    });
  }

  //  Step 5: Resolve student from email 
  const user = await prisma.user.findUnique({
    where: { email: studentEmail.toLowerCase() },
    select: { matricNumber: true },
  });

  if (!user) {
    log.warn("webhook.student_not_found");
    return res.status(404).json({
      success: false,
      message: "Student not found.",
    });
  }

  //  Step 6: Credit wallet
  try {
    const result = await creditWallet(user.matricNumber, depositAmount);

    if (!result) {
      log.warn("webhook.wallet_not_found");
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const { previousBalance, newBalance } = result;

    //  Step 7: Mark as processed 
    processedTransactions.add(txReference);

    log.info({ previousBalance, newBalance }, "webhook.wallet_credited");

    //  Step 8: Send notification to student 
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

    //  Step 9: Remove from blacklist if threshold crossed 
    // If the student's balance crossed above the threshold after this
    // top-up, remove them from the blacklist and broadcast to terminals.
    if (hasCrossedAboveThreshold(previousBalance, newBalance)) {
      // 1. Get the student's card UID
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

      // 2. Remove from blacklist DB
      await prisma.blacklist.deleteMany({
        where: { student_uid: user.matricNumber },
      });

      // 3. Notify student
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
