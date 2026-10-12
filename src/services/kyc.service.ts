import prisma from "../lib/prisma.js";
import cloudinary from "../config/cloudinary.js";
import { sendNotification } from "./notification.service.js";
import logger from "../config/logger.js";

const LINK_TTL_SECONDS = 30 * 60;

// Uploads as an authenticated (private) jpg and returns its public_id.
// The stored asset has no public URL: it can only be reached through a signed link.
const uploadIdCard = (fileBuffer: Buffer, userId: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "ctransit/kyc",
        public_id: `kyc_${userId}`,
        overwrite: true,
        invalidate: true,
        resource_type: "image",
        type: "authenticated",
        format: "jpg",
      },
      (error, result) => (error || !result ? reject(error ?? new Error("UPLOAD_FAILED")) : resolve(result.public_id))
    );
    stream.end(fileBuffer);
  });

// Temporary signed download link for a stored public_id. Legacy rows that still hold a
// public URL are returned unchanged.
const signedIdCardUrl = (stored: string): string =>
  stored.startsWith("http")
    ? stored
    : cloudinary.utils.private_download_url(stored, "jpg", {
        type: "authenticated",
        resource_type: "image",
        expires_at: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
      });

// Drops the stored image reference from rows returned to agents after a decision.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const withoutImage = <T extends { idCardImageUrl: string }>({ idCardImageUrl: _omit, ...rest }: T) => rest;

// A resubmission after rejection overwrites the existing row.
const submitKyc = async (userId: string, fileBuffer: Buffer) => {
  const idCardImageUrl = await uploadIdCard(fileBuffer, userId);

  const kyc = await prisma.kyc.upsert({
    where: { userId },
    update: { idCardImageUrl, status: "PENDING", rejectionReason: null, reviewedAt: null, submittedAt: new Date() },
    create: { userId, idCardImageUrl },
  });
  logger.info({ userId, kycId: kyc.id }, "kyc.submitted");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { matricNumber: true } });
  if (user) {
    sendNotification(
      user.matricNumber,
      "KYC Submitted",
      "Your ID card has been submitted for review. You will be notified once it has been reviewed."
    ).catch(() => {});
  }
  return kyc;
};

const getKycByUserId = (userId: string) => prisma.kyc.findUnique({ where: { userId } });

// Approves the KYC and activates the wallet in one transaction. It does not change email verification.
const approveKyc = async (userId: string) => {
  const { kyc, matricNumber } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { matricNumber: true } });
    if (!user) throw new Error("USER_NOT_FOUND");
    if (!(await tx.kyc.findUnique({ where: { userId }, select: { id: true } }))) throw new Error("KYC_NOT_FOUND");

    const kyc = await tx.kyc.update({
      where: { userId },
      data: { status: "APPROVED", reviewedAt: new Date(), rejectionReason: null },
    });
    await tx.wallet.upsert({
      where: { student_uid: user.matricNumber },
      update: { is_linked: true },
      create: { student_uid: user.matricNumber, balance: 0, is_linked: true },
    });

    logger.info({ userId, matricNumber: user.matricNumber }, "kyc.approved_wallet_created");
    return { kyc, matricNumber: user.matricNumber };
  });

  sendNotification(
    matricNumber,
    "KYC Approved",
    "Your identity has been verified successfully. Your wallet is now active. You can top up from your dashboard."
  ).catch(() => {});

  return withoutImage(kyc);
};

const rejectKyc = async (userId: string, reason: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { matricNumber: true } });
  if (!user) throw new Error("USER_NOT_FOUND");
  if (!(await prisma.kyc.findUnique({ where: { userId }, select: { id: true } }))) throw new Error("KYC_NOT_FOUND");

  const kyc = await prisma.kyc.update({
    where: { userId },
    data: { status: "REJECTED", reviewedAt: new Date(), rejectionReason: reason },
  });

  sendNotification(
    user.matricNumber,
    "KYC Rejected",
    `Your ID card verification was unsuccessful. Reason: ${reason}. Please resubmit with a clearer image.`
  ).catch(() => {});

  return withoutImage(kyc);
};

// Agent review queue, oldest first. Image links are temporary and signed.
const getPendingKyc = async () => {
  const rows = await prisma.kyc.findMany({
    where: { status: "PENDING" },
    orderBy: { submittedAt: "asc" },
    select: { id: true, userId: true, idCardImageUrl: true, submittedAt: true },
  });
  return rows.map((r) => ({ ...r, idCardImageUrl: signedIdCardUrl(r.idCardImageUrl) }));
};

export { submitKyc, getKycByUserId, approveKyc, rejectKyc, getPendingKyc };