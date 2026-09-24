import { Router } from "express";
import {
  authenticateToken,
  requireDriver,
} from "../middleware/auth.middleware.js";
import {
  loginLimiter,
  driverCardLinkLimiter,
  driverPinLimiter,
  bankVerifyLimiter,
} from "../middleware/rate-limit.middleware.js";
import {
  loginDriverHandler,
  getDriverMeHandler,
  getDriverDashboardHandler,
  getDriverRidesHandler,
  createDriverWithdrawalHandler,
  getDriverWithdrawalsHandler,
  linkDriverCardHandler,
  setDriverCardPinHandler,
  getDriverPinStatusHandler,
  verifyDriverBankHandler,
  getDriverNotificationsHandler,
  markDriverNotificationReadHandler,
  markAllDriverNotificationsReadHandler,
} from "../controller/driver.controller.js";
import { handlePaymentWebhook } from "../controller/webhook.controller.js";

const router = Router();

// Public Routes
// 1. POST /api/drivers/login
router.post("/login", loginLimiter, loginDriverHandler);
router.post("/payout-webhook", handlePaymentWebhook);
router.post("/webhook", handlePaymentWebhook);

// Protected Driver Routes 
router.use(authenticateToken);
router.use(requireDriver);

// 2. GET /api/drivers/me
router.get("/me", getDriverMeHandler);

// 3. GET /api/drivers/dashboard
router.get("/dashboard", getDriverDashboardHandler);

// 4. GET /api/drivers/rides
router.get("/rides", getDriverRidesHandler);

// 5. POST /api/drivers/withdraw
router.post("/withdraw", createDriverWithdrawalHandler);

// 6. GET /api/drivers/withdrawals
router.get("/withdrawals", getDriverWithdrawalsHandler);

// 7. POST /api/drivers/card/link
router.post("/card/link", driverCardLinkLimiter, linkDriverCardHandler);

// 8. POST /api/drivers/card/pin
router.post("/card/pin", driverPinLimiter, setDriverCardPinHandler);

// 9. GET /api/drivers/card/pin/status
router.get("/card/pin/status", getDriverPinStatusHandler);

// 10. POST /api/drivers/bank/verify
router.post("/bank/verify", bankVerifyLimiter, verifyDriverBankHandler);

// 11. GET /api/drivers/notifications
router.get("/notifications", getDriverNotificationsHandler);

// 10. PATCH /api/drivers/notifications/mark-all-read (must be before :id)
router.patch("/notifications/mark-all-read", markAllDriverNotificationsReadHandler);

// 9. PATCH /api/drivers/notifications/:id/read (and :id/mark-read alias)
router.patch("/notifications/:id/read", markDriverNotificationReadHandler);
router.patch("/notifications/:id/mark-read", markDriverNotificationReadHandler);

export default router;
