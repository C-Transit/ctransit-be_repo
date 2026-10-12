import prisma from "../lib/prisma.js";
import { buildDeltaCommand} from "../utils/parser.js";
import { sendNotification } from "./notification.service.js"; 
import { enqueueBroadcast } from "../utils/bridge.js";
import logger from "../config/logger.js";

export interface ConfirmRegistrationResult {
  success: boolean;
  message: string;
  matricNumber?: string;
  cardUid?: string;
  alreadyLinked?: boolean;
}

const alreadyLinkedResult = (matricNumber: string, cardUid: string): ConfirmRegistrationResult => ({
  success: true,
  message: "Card already linked",
  matricNumber,
  cardUid,
  alreadyLinked: true,
});

const OTP_USED_MESSAGE = "This OTP has already been used. Please tap your card again for a new OTP.";

const REGISTRATION_ERRORS: Record<string, string> = {
  OTP_EXPIRED: "OTP has expired. Please tap your card again.",
  CARD_ALREADY_LINKED: "This card is already linked to another user.",
  STUDENT_ALREADY_HAS_CARD: "This student already has a different card linked.",
};

async function confirmRegistration(otp: string, userId: string): Promise<ConfirmRegistrationResult> {
  const log = logger.child({ userId });

  const otpRecord = await prisma.registrationOtp.findUnique({ where: { otp } });
  if (!otpRecord) {
    return { success: false, message: "Invalid OTP. Please tap your card again." };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true },
  });
  if (!user) {
    log.warn("registration.student_not_found");
    return { success: false, message: "Student not found. Please check your matric number." };
  }

  const { card_uid: cardUid, terminal_id: originTerminalId } = otpRecord;
  const matric = user.matricNumber;

  // A used OTP is fine if this student already owns the card (double submit).
  const usedByThisStudent = async () => {
    const mapping = await prisma.cardMapping.findUnique({
      where: { student_uid: matric },
      select: { card_uid: true },
    });
    return mapping?.card_uid === cardUid ? alreadyLinkedResult(matric, cardUid) : null;
  };

  if (otpRecord.used) {
    return (await usedByThisStudent()) ?? { success: false, message: OTP_USED_MESSAGE };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.registrationOtp.updateMany({
        where: { otp, used: false },
        data: { used: true },
      });
      if (consumed.count === 0) throw new Error("OTP_ALREADY_USED");
      if (otpRecord.expires_at < new Date()) throw new Error("OTP_EXPIRED");

      const [cardOwner, studentCard] = await Promise.all([
        tx.cardMapping.findUnique({ where: { card_uid: cardUid } }),
        tx.cardMapping.findUnique({ where: { student_uid: matric } }),
      ]);
      if (cardOwner && cardOwner.student_uid !== matric) throw new Error("CARD_ALREADY_LINKED");
      if (studentCard && studentCard.card_uid !== cardUid) throw new Error("STUDENT_ALREADY_HAS_CARD");
      if (!cardOwner && !studentCard) {
        await tx.cardMapping.create({ data: { card_uid: cardUid, student_uid: matric } });
      }

      // Activate only after every check passed, in the same transaction.
      await tx.wallet.upsert({
        where: { student_uid: matric },
        update: { is_linked: true },
        create: { student_uid: matric, balance: 0, is_linked: true },
      });
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "OTP_ALREADY_USED") {
      return (await usedByThisStudent()) ?? { success: false, message: OTP_USED_MESSAGE };
    }
    if (REGISTRATION_ERRORS[code]) return { success: false, message: REGISTRATION_ERRORS[code] };

    log.error({ err: code || "Unknown error" }, "registration.transaction_failed");
    return { success: false, message: "Database error during card registration." };
  }

  log.info({ matricNumber: matric, originTerminalId }, "registration.card_linked");

  sendNotification(
    matric,
    "Card Linked Successfully 💳",
    "Your NFC card has been linked to your CTransit wallet. You can now tap your card on any terminal to pay for rides."
  ).catch(() => {});

  try {
    const result = await enqueueBroadcast(buildDeltaCommand("ADD", "WL", cardUid));
    if (result.failedTerminals?.length) {
      log.error({ failedTerminals: result.failedTerminals }, "registration.whitelist_broadcast_partial");
    }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : "Unknown error" }, "registration.whitelist_broadcast_failed");
  }

  return { success: true, message: "Card successfully linked and activated.", matricNumber: matric, cardUid };
}

export interface CreateRegistrationOtpParams {
  otp: string;
  cardUid: string;
  terminalId: string;
  agentUid?: string | null;
  expiresInMinutes?: number;
}

export async function createRegistrationOtp(params: CreateRegistrationOtpParams) {
  const { otp, cardUid, terminalId, agentUid, expiresInMinutes = 10 } = params;
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  return prisma.registrationOtp.create({
    data: {
      otp,
      card_uid: cardUid,
      terminal_id: terminalId,
      agent_uid: agentUid || null,
      expires_at: expiresAt,
      used: false,
    },
  });
}

// Registration OTPs are kept 10 minutes past expiry (so a repeated submit still resolves), then deleted.
export async function purgeOldRegistrationOtps(): Promise<number> {
  const { count } = await prisma.registrationOtp.deleteMany({
    where: { expires_at: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
  });
  return count;
}

export { confirmRegistration };
