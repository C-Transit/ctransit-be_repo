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
  bankResolveLimiter,
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
  resolveDriverBankHandler,
  getBanksHandler,
  getDriverNotificationsHandler,
  markDriverNotificationReadHandler,
  markAllDriverNotificationsReadHandler,
  unlinkDriverCardHandler,
} from "../controller/driver.controller.js";

const router = Router();

// Public Routes
// 1. POST /api/drivers/login
router.post("/login", loginLimiter, loginDriverHandler);

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

// 8a. POST /api/drivers/card/unlink
router.post("/card/unlink", driverPinLimiter, unlinkDriverCardHandler);

// 9. GET /api/drivers/card/pin/status
router.get("/card/pin/status", getDriverPinStatusHandler);

// 10. GET /api/drivers/banks (bank dropdown: name + provider code)
router.get("/banks", getBanksHandler);

// 10a. POST /api/drivers/bank/resolve (read-only name lookup, nothing saved)
router.post("/bank/resolve", bankResolveLimiter, resolveDriverBankHandler);

// 10b. POST /api/drivers/bank/verify (PIN required, saves the destination)
router.post("/bank/verify", bankVerifyLimiter, verifyDriverBankHandler);

// 11. GET /api/drivers/notifications
router.get("/notifications", getDriverNotificationsHandler);

// 10. PATCH /api/drivers/notifications/mark-all-read (must be before :id)
router.patch("/notifications/mark-all-read", markAllDriverNotificationsReadHandler);

// 9. PATCH /api/drivers/notifications/:id/read (and :id/mark-read alias)
router.patch("/notifications/:id/read", markDriverNotificationReadHandler);
router.patch("/notifications/:id/mark-read", markDriverNotificationReadHandler);

export default router;
