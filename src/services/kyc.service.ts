// kyc.service.ts
"use strict";

import prisma from "../lib/prisma.js";
import cloudinary from "../config/cloudinary.js";
import { getRedisClient, cacheKeys } from "../config/redis.js";
import { sendNotification } from "./notification.service.js";
import logger from "../config/logger.js";

// uploadIdCardToCloudinary uploads the ID card image to Cloudinary and returns the secure URL.
const uploadIdCardToCloudinary = (
  fileBuffer: Buffer,
  userId: string
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "ctransit/kyc",
        public_id: `kyc_${userId}`,
        overwrite: true,
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result?.secure_url ?? "");
      }
    );
    stream.end(fileBuffer);
  });
};

// submit Kyc handles the submission of a student's KYC information. It uploads the ID card image to Cloudinary, updates or creates the KYC record in the database, and sends a notification to the student.
const submitKyc = async (userId: string, fileBuffer: Buffer) => {
  logger.info({ userId }, "kyc.upload_starting");

  const idCardImageUrl = await uploadIdCardToCloudinary(fileBuffer, userId);

  logger.info({ userId, idCardImageUrl }, "kyc.upload_complete");

  // Upsert instead of create — if the student resubmits (e.g. after rejection),
  // we overwrite the existing row rather than hitting the userId unique constraint.
  const kyc = await prisma.kyc.upsert({
    where: { userId },
    update: {
      idCardImageUrl,
      status: "PENDING", 
      rejectionReason: null,
      reviewedAt: null,
      submittedAt: new Date(),
    },
    create: {
      userId,
      idCardImageUrl,
    },
  });

  logger.info({ userId, kycId: kyc.id }, "kyc.submitted");

  // Notify student — fire and forget
  const submittingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true },
  });
  if (submittingUser) {
    sendNotification(
      submittingUser.matricNumber,
      "KYC Submitted 📋",
      "Your ID card has been submitted for review. You will be notified once it has been reviewed."
    ).catch(() => {});
  }
  return kyc;
};

const getKycByUserId = async (userId: string) => {
  return prisma.kyc.findUnique({ where: { userId } });
};

// approveKyc approves a student's KYC submission, updates the KYC status, activates the wallet, and sends a notification to the student.
const approveKyc = async (userId: string) => {
  const redis = getRedisClient();

  const { kyc, matricNumber } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { matricNumber: true },
    });

    if (!user) throw new Error("User not found");

    const kyc = await tx.kyc.update({
      where: { userId },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        rejectionReason: null,
      },
    });

    await tx.user.update({
      where: { id: userId },
      data: { isVerified: true },
    });

    await tx.wallet.upsert({
      where: { student_uid: user.matricNumber },
      update: { is_linked: true },
      create: {
        student_uid: user.matricNumber,
        balance: 0,
        is_linked: true,
      },
    });

    logger.info(
      { userId, matricNumber: user.matricNumber },
      "kyc.approved_wallet_created"
    );

    return { kyc, matricNumber: user.matricNumber };
  });

  await redis.del(cacheKeys.wallet(matricNumber));
  sendNotification(
    matricNumber,
    "KYC Approved ✅",
    "Your identity has been verified. Your wallet is now active — request your virtual account to start topping up."
  ).catch(() => {});
  logger.debug({ matricNumber }, "kyc.wallet_cache_invalidated_after_approval");

  return kyc;
};

const rejectKyc = async (userId: string, reason: string) => {
  // Fetch matricNumber for notification
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true },
  });

  const kyc = await prisma.kyc.update({
    where: { userId },
    data: {
      status: "REJECTED",
      reviewedAt: new Date(),
      rejectionReason: reason,
    },
  });

  if (user) {
    sendNotification(
      user.matricNumber,
      "KYC Rejected ❌",
      `Your ID card verification was unsuccessful. Reason: ${reason}. Please resubmit with a clearer image.`
    ).catch(() => {});
  }

  return kyc;
};

// ─────────────────────────────────────────────
// getPendingKyc
// Agent queue — oldest-first.
// ─────────────────────────────────────────────
const getPendingKyc = async () => {
  return prisma.kyc.findMany({
    where: { status: "PENDING" },
    orderBy: { submittedAt: "asc" },
    select: {
      id: true,
      userId: true,
      idCardImageUrl: true,
      submittedAt: true,
    },
  });
};

export { submitKyc, getKycByUserId, approveKyc, rejectKyc, getPendingKyc };
