import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import { sendNotification } from "./notification.service.js";

// ─────────────────────────────────────────────
// resolveMatricNumber
// Internal helper — resolves a User.id to the
// student's matricNumber. Used in every function
// here since the JWT carries userId, not matric.
// Throws STUDENT_NOT_FOUND if the id is invalid
// or doesn't belong to a STUDENT role.
// ─────────────────────────────────────────────
async function resolveMatricNumber(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true, role: true },
  });

  if (!user || user.role !== "STUDENT") {
    throw new Error("STUDENT_NOT_FOUND");
  }

  return user.matricNumber;
}

// ─────────────────────────────────────────────
// raiseDispute
//
// Student raises a dispute against a RIDE transaction.
//
// Guards (in order):
// 1. Transaction must exist
// 2. Transaction must belong to this student
// 3. Only RIDE transactions are disputable —
//    TOPUP and REFUND have their own resolution
//    paths (Monnify and admin manual credit)
// 4. No open or under-review dispute already exists
//    on this transaction — prevents spam. A closed
//    (RESOLVED/REJECTED) dispute can be re-raised.
// ─────────────────────────────────────────────
async function raiseDispute(
  userId: string,
  transactionId: string,
  description: string
) {
  const matricNumber = await resolveMatricNumber(userId);

  const transaction = await prisma.transaction.findUnique({
    where: { transaction_id: transactionId },
    select: { student_uid: true, type: true },
  });

  if (!transaction) throw new Error("TRANSACTION_NOT_FOUND");

  // Ownership check — student cannot dispute another student's transaction
  if (transaction.student_uid !== matricNumber) {
    throw new Error("TRANSACTION_NOT_OWNED");
  }

  if (transaction.type !== "RIDE") {
    throw new Error("ONLY_RIDE_TRANSACTIONS_DISPUTABLE");
  }

  // Check for an active (non-closed) dispute on this transaction
  const existingActive = await prisma.dispute.findFirst({
    where: {
      transaction_id: transactionId,
      status: { in: ["OPEN", "UNDER_REVIEW"] },
    },
    select: { id: true },
  });

  if (existingActive) throw new Error("DISPUTE_ALREADY_ACTIVE");

  const dispute = await prisma.dispute.create({
    data: {
      student_uid: matricNumber,
      transaction_id: transactionId,
      description: description.trim(),
      // status defaults to OPEN via schema
    },
    select: {
      id: true,
      status: true,
      description: true,
      createdAt: true,
      transaction_id: true,
    },
  });

  sendNotification(
    matricNumber,
    "Dispute Submitted 📋",
    `Your dispute for transaction ${transactionId} has been received and is under review. We will notify you of any updates.`
  ).catch(() => {});

  logger.info(
    { disputeId: dispute.id, matricNumber, transactionId },
    "dispute.raised_by_student"
  );

  return dispute;
}

// ─────────────────────────────────────────────
// getStudentDisputes
// Returns all disputes raised by this student,
// newest first. Includes transaction summary so
// the student can see which ride each dispute is
// about without a separate round-trip.
// ─────────────────────────────────────────────
async function getStudentDisputes(userId: string) {
  const matricNumber = await resolveMatricNumber(userId);

  return prisma.dispute.findMany({
    where: { student_uid: matricNumber },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      description: true,
      status: true,
      resolution: true,
      resolvedAt: true,
      createdAt: true,
      transaction: {
        select: {
          transaction_id: true,
          type: true,
          amount: true,
          terminal_id: true,
          synced_at: true,
        },
      },
    },
  });
}

export { raiseDispute, getStudentDisputes };
