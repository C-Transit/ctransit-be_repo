import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";

// ─────────────────────────────────────────────
// resolveMatricNumber
// Same pattern as dispute.service.ts — resolves
// User.id → matricNumber for student routes.
// Throws USER_NOT_FOUND if invalid (any role is
// fine here since admin could query too, but in
// practice this is always called with a student).
// ─────────────────────────────────────────────
async function resolveMatricNumber(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true },
  });

  if (!user) throw new Error("USER_NOT_FOUND");
  return user.matricNumber;
}

// ─────────────────────────────────────────────
// getNotifications
// Returns the student's full notification feed
// (newest first) plus the unread badge count.
// Both queries run in a single $transaction for
// a consistent snapshot.
// ─────────────────────────────────────────────
async function getNotifications(userId: string) {
  const matricNumber = await resolveMatricNumber(userId);

  const [notifications, unreadCount] = await prisma.$transaction([
    prisma.notification.findMany({
      where: { student_uid: matricNumber },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        body: true,
        isRead: true,
        createdAt: true,
      },
    }),
    prisma.notification.count({
      where: { student_uid: matricNumber, isRead: false },
    }),
  ]);

  return { notifications, unreadCount };
}

// ─────────────────────────────────────────────
// markNotificationRead
// Marks a single notification as read.
// Ownership check ensures a student cannot mark
// another student's notification as read by
// guessing a UUID.
// ─────────────────────────────────────────────
async function markNotificationRead(notificationId: string, userId: string) {
  const matricNumber = await resolveMatricNumber(userId);

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { student_uid: true, isRead: true },
  });

  if (!notification) throw new Error("NOTIFICATION_NOT_FOUND");

  if (notification.student_uid !== matricNumber) {
    throw new Error("NOTIFICATION_NOT_OWNED");
  }

  // Idempotent — already read is fine, no error
  if (notification.isRead) {
    return { id: notificationId, isRead: true };
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: { isRead: true },
    select: { id: true, isRead: true },
  });
}

// ─────────────────────────────────────────────
// markAllNotificationsRead
// Bulk-marks all unread notifications for this
// student. Returns how many were updated so the
// frontend can decrement the badge accurately.
// ─────────────────────────────────────────────
async function markAllNotificationsRead(userId: string) {
  const matricNumber = await resolveMatricNumber(userId);

  const result = await prisma.notification.updateMany({
    where: { student_uid: matricNumber, isRead: false },
    data: { isRead: true },
  });

  logger.info(
    { matricNumber, updatedCount: result.count },
    "notification.all_marked_read"
  );

  return { updatedCount: result.count };
}

// ─────────────────────────────────────────────
// sendNotification
// Admin/agent creates a notification for a student.
// Accepts matricNumber directly (not userId) since
// the admin addresses students by their matric.
// Verifies the student exists before creating.
// ─────────────────────────────────────────────
async function sendNotification(
  studentMatric: string,
  title: string,
  body: string
) {
  const normalisedMatric = studentMatric.toUpperCase();

  const student = await prisma.user.findUnique({
    where: { matricNumber: normalisedMatric },
    select: { id: true, role: true },
  });

  if (!student || student.role !== "STUDENT") {
    throw new Error("STUDENT_NOT_FOUND");
  }

  const notification = await prisma.notification.create({
    data: {
      student_uid: normalisedMatric,
      title: title.trim(),
      body: body.trim(),
    },
    select: {
      id: true,
      title: true,
      body: true,
      isRead: true,
      createdAt: true,
    },
  });

  logger.info(
    { notificationId: notification.id, studentMatric: normalisedMatric },
    "notification.sent_by_admin"
  );

  return notification;
}

export {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  sendNotification,
};
