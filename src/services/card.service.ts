import prisma from "../lib/prisma.js";
import { getRedisClient, cacheKeys } from "../config/redis.js";
import { terminalProvisioningService } from "./terminal-provisioning.service.js";
import logger from "../config/logger.js";

export interface UnlinkCardParams {
  cardUid?: string;
  userIdentifier?: string;
  callerId: string;
  callerRole: string;
}

export interface UnlinkCardResult {
  success: boolean;
  message: string;
  unlinked: {
    cardUid: string;
    studentUid: string;
    userRole: string;
    userName: string;
    unlinkedAt: string;
    terminalSyncSuccess: boolean;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export async function unlinkCard(
  params: UnlinkCardParams,
  dbClient: DbClient = prisma
): Promise<UnlinkCardResult> {
  const { cardUid, userIdentifier, callerId, callerRole } = params;

  // 1. Authorization check: Only ADMIN and AGENT can unlink cards
  if (callerRole !== "ADMIN" && callerRole !== "AGENT") {
    logger.warn(
      { callerId, callerRole },
      "card_service.unlink_unauthorized_caller"
    );
    throw new Error("UNAUTHORIZED_CALLER");
  }

  const cleanCardUid = cardUid ? cardUid.trim().toUpperCase() : undefined;
  const cleanUserIdentifier = userIdentifier ? userIdentifier.trim() : undefined;

  if (!cleanCardUid && !cleanUserIdentifier) {
    throw new Error("MISSING_IDENTIFIER");
  }

  // 2. Identify the card mapping
  let mapping = null;

  if (cleanCardUid) {
    mapping = await dbClient.cardMapping.findUnique({
      where: { card_uid: cleanCardUid },
    });
  }

  let resolvedUser = null;
  if (cleanUserIdentifier) {
    resolvedUser = await dbClient.user.findFirst({
      where: {
        OR: [
          { matricNumber: cleanUserIdentifier.toUpperCase() },
          { email: cleanUserIdentifier.toLowerCase() },
          { id: cleanUserIdentifier },
        ],
      },
      select: {
        id: true,
        matricNumber: true,
        role: true,
        firstname: true,
        lastname: true,
      },
    });

    if (!resolvedUser && !mapping) {
      throw new Error("USER_NOT_FOUND");
    }

    if (!mapping && resolvedUser) {
      mapping = await dbClient.cardMapping.findUnique({
        where: { student_uid: resolvedUser.matricNumber },
      });
    }
  }

  if (!mapping) {
    if (resolvedUser) {
      throw new Error("CARD_ALREADY_UNLINKED");
    }
    throw new Error("CARD_NOT_FOUND");
  }

  // If both cardUid and userIdentifier were supplied, ensure they match the mapping
  if (cleanCardUid && mapping.card_uid !== cleanCardUid) {
    throw new Error("CARD_USER_MISMATCH");
  }

  if (
    resolvedUser &&
    mapping.student_uid.toUpperCase() !== resolvedUser.matricNumber.toUpperCase()
  ) {
    throw new Error("CARD_BELONGS_TO_ANOTHER_USER");
  }

  // Fetch full user record if not fetched yet
  if (!resolvedUser) {
    resolvedUser = await dbClient.user.findUnique({
      where: { matricNumber: mapping.student_uid },
      select: {
        id: true,
        matricNumber: true,
        role: true,
        firstname: true,
        lastname: true,
      },
    });
  }

  const targetCardUid = mapping.card_uid;
  const targetStudentUid = mapping.student_uid;

  // 3. Authoritative DB Mutation in a transaction
  await dbClient.$transaction(async (tx: DbClient) => {
    // Delete the CardMapping record
    await tx.cardMapping.delete({
      where: { card_uid: targetCardUid },
    });

    // If user is STUDENT, reset wallet linking status
    if (resolvedUser?.role === "STUDENT" || !resolvedUser) {
      await tx.wallet.updateMany({
        where: { student_uid: targetStudentUid },
        data: { is_linked: false },
      });
    }

    // If user is DRIVER or has driver credentials, remove terminal card credential
    if (tx.driverCardCredential) {
      await tx.driverCardCredential.deleteMany({
        where: {
          OR: [
            { card_uid: targetCardUid },
            { driver_uid: targetStudentUid },
          ],
        },
      });
    }
  });

  // 4. Invalidate Redis cache
  try {
    const redis = getRedisClient();
    if (redis) {
      await redis.del(cacheKeys.cardMap(targetCardUid));
      logger.info({ cardUid: targetCardUid }, "card_service.redis_cache_invalidated");
    }
  } catch (redisErr) {
    logger.warn(
      { cardUid: targetCardUid, err: redisErr instanceof Error ? redisErr.message : String(redisErr) },
      "card_service.redis_cache_invalidation_error_ignored"
    );
  }

  // 5. Terminal Whitelist Synchronization (DEL:WL)
  let terminalSyncSuccess: boolean;
  try {
    const deprovResult = await terminalProvisioningService.deprovisionCard(targetCardUid);
    terminalSyncSuccess = deprovResult.success;
  } catch (termErr) {
    terminalSyncSuccess = false;
    logger.error(
      { cardUid: targetCardUid, err: termErr instanceof Error ? termErr.message : String(termErr) },
      "card_service.terminal_deprovision_failed"
    );
  }

  logger.info(
    {
      cardUid: targetCardUid,
      studentUid: targetStudentUid,
      unlinkedBy: callerId,
      callerRole,
      terminalSyncSuccess,
    },
    "card_service.card_unlinked_successfully"
  );

  return {
    success: true,
    message: "Card unlinked successfully",
    unlinked: {
      cardUid: targetCardUid,
      studentUid: targetStudentUid,
      userRole: resolvedUser?.role || "STUDENT",
      userName: resolvedUser ? `${resolvedUser.firstname} ${resolvedUser.lastname}` : targetStudentUid,
      unlinkedAt: new Date().toISOString(),
      terminalSyncSuccess,
    },
  };
}
