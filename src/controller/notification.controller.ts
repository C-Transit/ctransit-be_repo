import { Router, type Response } from "express";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../services/notification.service.js";

const router = Router();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");

// GET /api/notifications: the full feed plus the unread count.
router.get("/", async (req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, ...(await getNotifications(req.user!.userId)) });
  } catch (error) {
    logger.error({ err: errMsg(error) }, "notification.route_list_error");
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// PATCH /api/notifications/mark-all-read (defined before /:id so "mark-all-read" isn't read as an id)
router.patch("/mark-all-read", async (req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, ...(await markAllNotificationsRead(req.user!.userId)) });
  } catch (error) {
    logger.error({ err: errMsg(error) }, "notification.route_mark_all_read_error");
    return res.status(500).json({ error: "Failed to mark notifications as read" });
  }
});

// PATCH /api/notifications/:id/mark-read
router.patch("/:id/mark-read", async (req: CustomAuthRequest & { params: { id: string } }, res: Response) => {
  const { id } = req.params;
  try {
    const notification = await markNotificationRead(id, req.user!.userId);
    return res.status(200).json({ success: true, notification });
  } catch (error) {
    if (errMsg(error) === "NOTIFICATION_NOT_FOUND") {
      return res.status(404).json({ error: "Notification not found" });
    }
    logger.error({ err: errMsg(error), notificationId: id }, "notification.route_mark_read_error");
    return res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

export default router;