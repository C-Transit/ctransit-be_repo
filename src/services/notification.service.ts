import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";

const SELECT = { id: true, title: true, body: true, isRead: true, createdAt: true } as const;

// Notifications are keyed by matricNumber (students and drivers alike).
async function resolveMatricNumber(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { matricNumber: true } });
  if (!user) throw new Error("USER_NOT_FOUND");
  return user.matricNumber;
}

async function getNotifications(userId: string) {
  const matricNumber = await resolveMatricNumber(userId);

  const [notifications, unreadCount] = await prisma.$transaction([
    prisma.notification.findMany({
      where: { student_uid: matricNumber },
      orderBy: { createdAt: "desc" },
      select: SELECT,
    }),
    prisma.notification.count({ where: { student_uid: matricNumber, isRead: false } }),
  ]);

  return { notifications, unreadCount };
}

// Ownership is enforced in the where clause, so another user's id behaves as "not found".
async function markNotificationRead(notificationId: string, userId: string) {
  const matricNumber = await resolveMatricNumber(userId);

  const result = await prisma.notification.updateMany({
    where: { id: notificationId, student_uid: matricNumber },
    data: { isRead: true },
  });
  if (result.count === 0) throw new Error("NOTIFICATION_NOT_FOUND");

  return { id: notificationId, isRead: true };
}

async function markAllNotificationsRead(userId: string) {
  const matricNumber = await resolveMatricNumber(userId);
  const result = await prisma.notification.updateMany({
    where: { student_uid: matricNumber, isRead: false },
    data: { isRead: true },
  });
  logger.info({ matricNumber, updatedCount: result.count }, "notification.all_marked_read");
  return { updatedCount: result.count };
}

// Creates a notification for any existing user (student or driver), addressed by matricNumber.
async function sendNotification(matric: string, title: string, body: string) {
  const uid = matric.toUpperCase();

  const user = await prisma.user.findUnique({ where: { matricNumber: uid }, select: { id: true } });
  if (!user) throw new Error("STUDENT_NOT_FOUND");

  const notification = await prisma.notification.create({
    data: { student_uid: uid, title: title.trim(), body: body.trim() },
    select: SELECT,
  });

  logger.info({ notificationId: notification.id, studentMatric: uid }, "notification.sent");
  return notification;
}

export { getNotifications, markNotificationRead, markAllNotificationsRead, sendNotification };