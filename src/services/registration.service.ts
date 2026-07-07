"use strict";

import {
  getRedisClient,
  redisKeys,
  cacheKeys, // ✅ Added — needed for cache invalidation
  OTP_TTL_SECONDS,
} from "../config/redis.js";
import { activateWallet, prisma } from "./ledger.service.js";
import { buildDeltaCommand, type PendingLinkData } from "../utils/parser.js";
import { enqueueRoute } from "../utils/bridge.js";
import logger from "../config/logger.js";

export interface ConfirmRegistrationResult {
  success: boolean;
  message: string;
  matricNumber?: string;
  cardUid?: string;
}

async function handlePendingLink(
  terminalId: string,
  linkData: PendingLinkData
): Promise<void> {
  const redis = getRedisClient();
  const log = logger.child({
    terminalId,
    cardUid: linkData.uid,
    otp: linkData.otp,
  });

  const key = redisKeys.linkOtp(linkData.otp);

  // Store: otp -> cardUid|terminalId
  const value = `${linkData.uid}|${terminalId}`;
  await redis.setex(key, OTP_TTL_SECONDS, value);

  log.info(
    { ttlSeconds: OTP_TTL_SECONDS, cacheKey: key },
    "registration.otp_cached"
  );

  try {
    await enqueueRoute(terminalId, `REG:OTP,${linkData.otp}`);
    log.info({ otp: linkData.otp }, "registration.otp_sent_to_terminal_screen");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    log.error({ err: errMsg }, "registration.failed_to_send_otp_to_terminal");
  }
}

async function confirmRegistration(
  otp: string,
  userId: string
): Promise<ConfirmRegistrationResult> {
  const redis = getRedisClient();
  const log = logger.child({ otp, userId });

  const key = redisKeys.linkOtp(otp);
  const cached = await redis.get(key);

  if (!cached) {
    log.warn("registration.otp_not_found_or_expired");
    return {
      success: false,
      message: "OTP has expired or is invalid. Please tap your card again.",
    };
  }

  const [cardUid, originTerminalId] = cached.split("|");

  if (!cardUid || !originTerminalId) {
    log.error({ cached }, "registration.malformed_cache_value");
    return {
      success: false,
      message: "Internal registration state corrupted.",
    };
  }

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

    // ✅ Invalidate wallet cache — wallet was just created/activated.
    // Next tap reads fresh wallet state from DB instead of stale null.
    await redis.del(cacheKeys.wallet(user.matricNumber));
    log.debug(
      { matricNumber: user.matricNumber },
      "registration.wallet_cache_invalidated"
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

  // ✅ Invalidate card mapping cache — card_uid now points to a new matricNumber.
  // Without this, ingestion.service.ts would serve the old (stale) mapping from
  // cache if this card was previously linked to a different student.
  await redis.del(cacheKeys.cardMap(cardUid));
  log.debug({ cardUid }, "registration.card_map_cache_invalidated");

  // Consume OTP — cannot be reused
  await redis.del(key);
  log.debug({ key }, "registration.otp_consumed_from_redis");

  // Broadcast ADD:WL,cardUid to all terminals
  // Uses cardUid (not matricNumber) — terminals identify cards by hardware UID
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

export { handlePendingLink, confirmRegistration };
