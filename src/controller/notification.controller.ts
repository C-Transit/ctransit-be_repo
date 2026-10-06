import { Router, type Response } from "express";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../services/notification.service.js";

const router = Router();

// GET /api/notifications
// Student's full notification feed + unread count.
router.get("/", async (req: CustomAuthRequest, res: Response) => {
  try {
    const result = await getNotifications(req.user!.userId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "notification.route_list_error");
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// PATCH /api/notifications/mark-all-read
// Must be defined BEFORE /:id/mark-read so Express
// doesn't interpret "mark-all-read" as a dynamic :id.
router.patch("/mark-all-read", async (req: CustomAuthRequest, res: Response) => {
  try {
    const result = await markAllNotificationsRead(req.user!.userId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "notification.route_mark_all_read_error");
    return res
      .status(500)
      .json({ error: "Failed to mark notifications as read" });
  }
});

// PATCH /api/notifications/:id/mark-read
// Marks a single notification as read.
router.patch(
  "/:id/mark-read",
  async (
    req: CustomAuthRequest & { params: { id: string } },
    res: Response
  ) => {
    const { id } = req.params;

    try {
      const notification = await markNotificationRead(id, req.user!.userId);
      return res.status(200).json({ success: true, notification });
    } catch (error) {
      if (error instanceof Error) {
        switch (error.message) {
          case "NOTIFICATION_NOT_FOUND":
            return res.status(404).json({ error: "Notification not found" });
          case "NOTIFICATION_NOT_OWNED":
            // 404 not 403 — don't confirm the notification exists
            return res.status(404).json({ error: "Notification not found" });
        }
      }

      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: errMessage, notificationId: id },
        "notification.route_mark_read_error"
      );
      return res
        .status(500)
        .json({ error: "Failed to mark notification as read" });
    }
  }
);

export default router;
