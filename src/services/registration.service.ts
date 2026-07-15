"use strict";

import prisma from "../lib/prisma.js";
import { activateWallet } from "./ledger.service.js";
import { buildDeltaCommand} from "../utils/parser.js";
import { sendNotification } from "./notification.service.js"; 
import { enqueueRoute } from "../utils/bridge.js";
import logger from "../config/logger.js";

export interface ConfirmRegistrationResult {
  success: boolean;
  message: string;
  matricNumber?: string;
  cardUid?: string;
}

async function confirmRegistration(
  otp: string,
  userId: string
): Promise<ConfirmRegistrationResult> {
  const log = logger.child({ otp, userId });

  // Look up OTP in DB instead of Redis
  const otpRecord = await prisma.registrationOtp.findUnique({
    where: { otp },
  });

  if (!otpRecord || otpRecord.used || otpRecord.expires_at < new Date()) {
    log.warn("registration.otp_not_found_or_expired");
    return {
      success: false,
      message: "OTP has expired or is invalid. Please tap your card again.",
    };
  }

  const { card_uid: cardUid, terminal_id: originTerminalId } = otpRecord;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true },
  });

  if (!user) {
    log.warn({ userId }, "registration.student_not_found");
    return {
      success: false,
      message: "Student not found. Please check your matric number.",
    };
  }

  log.info(
    { cardUid, originTerminalId, matricNumber: user.matricNumber },
    "registration.otp_confirmed"
  );

  try {
    await activateWallet(user.matricNumber);
    log.info(
      { matricNumber: user.matricNumber },
      "registration.wallet_activated"
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    log.error({ err: errMsg }, "registration.wallet_activation_failed");
    return {
      success: false,
      message: "Database error during wallet activation.",
    };
  }

  await prisma.cardMapping.upsert({
    where: { card_uid: cardUid },
    update: { student_uid: user.matricNumber },
    create: {
      card_uid: cardUid,
      student_uid: user.matricNumber,
    },
  });

  log.info(
    { cardUid, matricNumber: user.matricNumber },
    "registration.card_uid_mapped_to_student"
  );

  // Mark OTP as used — cannot be reused
  await prisma.registrationOtp.update({
    where: { otp },
    data: { used: true },
  });

  log.debug({ otp }, "registration.otp_consumed");

  // Notify student
  sendNotification(
    user.matricNumber,
    "Card Linked Successfully 💳",
    "Your NFC card has been linked to your CTransit wallet. You can now tap your card on any terminal to pay for rides."
  ).catch(() => {});

  const addWlCmd = buildDeltaCommand("ADD", "WL", cardUid);

  try {
    await enqueueRoute(originTerminalId, addWlCmd);
    log.info(
      { originTerminalId, addWlCmd },
      "registration.origin_terminal_synced"
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    log.error({ err: errMsg }, "registration.origin_sync_failed");
  }

  try {
    const allTerminals = await prisma.terminal.findMany({
      where: { terminal_id: { not: originTerminalId } },
      select: { terminal_id: true },
    });
    await Promise.allSettled(
      allTerminals.map((t: { terminal_id: string }) =>
        enqueueRoute(t.terminal_id, addWlCmd)
      )
    );
    log.info(
      { terminalCount: allTerminals.length },
      "registration.fleet_sync_queued"
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    log.error({ err: errMsg }, "registration.fleet_sync_error");
  }

  return {
    success: true,
    message: "Card successfully linked and activated.",
    matricNumber: user.matricNumber,
    cardUid,
  };
}

export { confirmRegistration };
