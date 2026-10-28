import type { Request, Response } from "express";
import logger from "../config/logger.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import {
  loginDriver,
  getDriverProfile,
  getDriverDashboard,
  getDriverRides,
  createDriverWithdrawal,
  getDriverWithdrawals,
  linkDriverCard,
  setDriverCardPin,
  getDriverPinStatus,
  verifyAndSaveDriverBank,
  resolveDriverBankAccount,
  getBanks,
  unlinkDriverCard,
} from "../services/driver.service.js";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../services/notification.service.js";

type ErrorTable = Record<string, [status: number, message: string]>;

const DRIVER_NOT_FOUND: ErrorTable = { DRIVER_NOT_FOUND: [404, "Driver not found"] };

// Maps a known service error to its response, otherwise logs and returns a generic 500.
function fail(res: Response, error: unknown, table: ErrorTable, event: string, fallback = "Server error") {
  const code = error instanceof Error ? error.message : "";
  const known = table[code];
  if (known) return res.status(known[0]).json({ success: false, message: known[1] });

  logger.error({ err: code || "Unknown error" }, event);
  return res.status(500).json({ success: false, message: fallback });
}

const page = (req: Request) => ({
  page: parseInt(req.query.page as string, 10) || 1,
  limit: parseInt(req.query.limit as string, 10) || 20,
});

// POST /api/drivers/login
export const loginDriverHandler = async (req: Request, res: Response) => {
  const { phone, pin } = req.body ?? {};
  if (!phone || !pin) {
    return res.status(400).json({ success: false, message: "Please provide phone and pin" });
  }

  try {
    const result = await loginDriver(String(phone), String(pin));
    return res.status(200).json({
      success: true,
      token: result.accessToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      driver: result.driver,
    });
  } catch (error) {
    return fail(
      res,
      error,
      {
        INVALID_CREDENTIALS: [401, "Invalid phone number or PIN"],
        TOO_MANY_ATTEMPTS: [429, "Too many failed attempts. Try again in 15 minutes."],
      },
      "driver.login_controller_error"
    );
  }
};

// GET /api/drivers/me
export const getDriverMeHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    const profile = await getDriverProfile(req.user!.userId);
    return res.status(200).json({ success: true, ...profile, driver: profile, data: profile });
  } catch (error) {
    return fail(res, error, DRIVER_NOT_FOUND, "driver.me_controller_error");
  }
};

// GET /api/drivers/dashboard
export const getDriverDashboardHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    const dashboard = await getDriverDashboard(req.user!.userId);
    return res.status(200).json({ success: true, ...dashboard, data: dashboard });
  } catch (error) {
    return fail(res, error, DRIVER_NOT_FOUND, "driver.dashboard_controller_error");
  }
};

// GET /api/drivers/rides
export const getDriverRidesHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    const { page: p, limit } = page(req);
    const result = await getDriverRides(req.user!.userId, p, limit);
    return res.status(200).json({
      success: true,
      data: result.rides,
      rides: result.rides,
      pagination: result.pagination,
    });
  } catch (error) {
    return fail(res, error, DRIVER_NOT_FOUND, "driver.rides_controller_error");
  }
};

// GET /api/drivers/banks: bank dropdown (name + provider code)
export const getBanksHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    const banks = await getBanks();
    return res.status(200).json({ success: true, data: banks, banks });
  } catch (error) {
    return fail(
      res,
      error,
      { BANK_LIST_NOT_SUPPORTED: [501, "Bank list is not supported by the payment provider"] },
      "driver.banks_controller_error",
      "Unable to load bank list"
    );
  }
};

// POST /api/drivers/bank/resolve { bankCode, accountNumber }
// Read-only preview: returns the resolved account name without changing the saved destination.
export const resolveDriverBankHandler = async (req: CustomAuthRequest, res: Response) => {
  const { bankCode, accountNumber } = req.body ?? {};
  if (!bankCode || !accountNumber) {
    return res.status(400).json({
      success: false,
      message: "bankCode and accountNumber are required",
    });
  }

  try {
    const data = await resolveDriverBankAccount({
      bankCode: String(bankCode).trim(),
      accountNumber: String(accountNumber).trim(),
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const known: ErrorTable = {
      INVALID_ACCOUNT_NUMBER: [400, "Account number must be exactly 10 digits"],
      INVALID_BANK_CODE: [400, "Please select a valid bank"],
      BANK_VERIFICATION_NOT_SUPPORTED: [501, "Bank account resolution is not supported by payment provider"],
      BANK_LIST_NOT_SUPPORTED: [501, "Bank list is not supported by the payment provider"],
    };
    if (known[code]) return res.status(known[code][0]).json({ success: false, message: known[code][1] });

    logger.warn({ err: code }, "driver.bank_resolve_failed");
    return res.status(400).json({
      success: false,
      message: "Could not resolve this account. Check the bank and account number.",
    });
  }
};

// POST /api/drivers/withdraw
export const createDriverWithdrawalHandler = async (req: CustomAuthRequest, res: Response) => {
  const { amount, remarks, pin, idempotencyKey } = req.body ?? {};
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Please specify a valid positive withdrawal amount",
    });
  }

  try {
    const result = await createDriverWithdrawal(req.user!.userId, {
      amount: parsedAmount,
      remarks: remarks ? String(remarks).trim() : undefined,
      pin: String(pin ?? "").trim(),
      idempotencyKey: idempotencyKey ? String(idempotencyKey).trim() : undefined,
    });
    const failed = result.status === "FAILED";
    return res.status(failed ? 200 : 201).json({
      success: !failed,
      message: failed
        ? "The payout could not be completed. Your money has been returned to your wallet."
        : "Withdrawal request submitted successfully",
      data: result,
      withdrawal: result,
    });
  } catch (error) {
    return fail(
      res,
      error,
      {
        BANK_NOT_VERIFIED: [
          400,
          "Bank account must be verified before initiating withdrawals. Please verify your bank account first.",
        ],
        INSUFFICIENT_BALANCE: [400, "Withdrawal amount exceeds available balance"],
        INVALID_AMOUNT: [400, "Please specify a valid positive withdrawal amount"],
        AMOUNT_TOO_LOW: [400, "Withdrawal amount is too low after fees"],
        INVALID_PIN_FORMAT: [400, "PIN must be exactly 4 digits"],
        INVALID_PIN: [400, "Incorrect PIN"],
        TOO_MANY_ATTEMPTS: [429, "Too many failed PIN attempts. Try again in 15 minutes."],
        WALLET_NOT_FOUND: [404, "Driver wallet not found"],
        IDEMPOTENCY_CONFLICT: [409, "Another withdrawal request is already processing. Please wait."],
        ...DRIVER_NOT_FOUND,
      },
      "driver.withdraw_controller_error"
    );
  }
};

// GET /api/drivers/withdrawals
export const getDriverWithdrawalsHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    const { page: p, limit } = page(req);
    const result = await getDriverWithdrawals(req.user!.userId, p, limit);
    return res.status(200).json({
      success: true,
      data: result.withdrawals,
      withdrawals: result.withdrawals,
      pagination: result.pagination,
    });
  } catch (error) {
    return fail(res, error, DRIVER_NOT_FOUND, "driver.withdrawals_controller_error");
  }
};

// POST /api/drivers/card/link
export const linkDriverCardHandler = async (req: CustomAuthRequest, res: Response) => {
  const { otp, pin, cardUid, driverId } = req.body ?? {};
  if (!otp || !pin) {
    return res.status(400).json({ success: false, message: "OTP and PIN are required" });
  }

  try {
    const result = await linkDriverCard(req.user!.userId, {
      otp: String(otp).trim(),
      pin: String(pin).trim(),
      cardUid: cardUid ? String(cardUid).trim() : undefined,
      driverId: driverId ? String(driverId).trim() : undefined,
    });
    return res.status(200).json(result);
  } catch (error) {
    return fail(
      res,
      error,
      {
        CARD_ALREADY_LINKED: [409, "Physical card is already linked to another user."],
        DRIVER_ALREADY_HAS_CARD: [
          400,
          "Driver already has a linked physical card. Please unlink the existing card first.",
        ],
        MISSING_TERMINAL_CONTEXT: [400, "Registration OTP is missing origin terminal context."],
        UNAUTHORIZED_DRIVER_ID: [403, "You can only link a card to your own driver account"],
        INVALID_OTP_FORMAT: [400, "OTP must be exactly 6 digits"],
        INVALID_OTP: [400, "Invalid OTP. Please tap your card again."],
        CARD_MISMATCH: [400, "Card UID does not match OTP registration."],
        OTP_ALREADY_USED: [
          400,
          "This OTP has already been used. Please tap your card again for a new OTP.",
        ],
        OTP_EXPIRED: [400, "OTP has expired. Please tap your card again."],
        INVALID_PIN_FORMAT: [400, "PIN must be exactly 4 digits"],
        INVALID_PIN: [400, "Incorrect PIN"],
        TOO_MANY_ATTEMPTS: [429, "Too many failed PIN attempts. Try again in 15 minutes."],
        ...DRIVER_NOT_FOUND,
      },
      "driver.card_link_controller_error"
    );
  }
};

// POST /api/drivers/card/pin
export const setDriverCardPinHandler = async (req: CustomAuthRequest, res: Response) => {
  const { pin } = req.body ?? {};
  if (!pin) {
    return res.status(400).json({ success: false, message: "PIN is required" });
  }

  try {
    const result = await setDriverCardPin(req.user!.userId, { pin: String(pin).trim() });
    return res.status(200).json(result);
  } catch (error) {
    return fail(
      res,
      error,
      {
        CARD_NOT_LINKED: [400, "Driver must link a physical card before setting a terminal PIN."],
        INVALID_PIN_FORMAT: [400, "PIN must be exactly 4 digits."],
        ...DRIVER_NOT_FOUND,
      },
      "driver.pin_set_controller_error"
    );
  }
};

// GET /api/drivers/card/pin/status
export const getDriverPinStatusHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json(await getDriverPinStatus(req.user!.userId));
  } catch (error) {
    return fail(res, error, DRIVER_NOT_FOUND, "driver.pin_status_controller_error");
  }
};

// POST /api/drivers/bank/verify { bankCode, accountNumber, pin }
export const verifyDriverBankHandler = async (req: CustomAuthRequest, res: Response) => {
  const { bankCode, accountNumber, pin } = req.body ?? {};
  if (!bankCode || !accountNumber || !pin) {
    return res.status(400).json({
      success: false,
      message: "bankCode, accountNumber and pin are required",
    });
  }

  try {
    const result = await verifyAndSaveDriverBank(req.user!.userId, {
      bankCode: String(bankCode).trim(),
      accountNumber: String(accountNumber).trim(),
      pin: String(pin).trim(),
    });
    return res.status(200).json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const known: ErrorTable = {
      INVALID_ACCOUNT_NUMBER: [400, "Account number must be exactly 10 digits"],
      INVALID_BANK_CODE: [400, "Please select a valid bank"],
      INVALID_PIN: [400, "Incorrect PIN"],
      TOO_MANY_ATTEMPTS: [429, "Too many failed PIN attempts. Try again in 15 minutes."],
      BANK_VERIFICATION_NOT_SUPPORTED: [501, "Bank account resolution is not supported by payment provider"],
      BANK_LIST_NOT_SUPPORTED: [501, "Bank list is not supported by the payment provider"],
      ...DRIVER_NOT_FOUND,
    };
    if (known[code]) return res.status(known[code][0]).json({ success: false, message: known[code][1] });

    // Anything else is a provider-side failure to resolve the account. Log the detail, keep the response generic.
    logger.warn({ err: code }, "driver.bank_verify_failed");
    return res.status(400).json({
      success: false,
      message: "Could not verify this account. Check the bank and account number.",
    });
  }
};

// GET /api/drivers/notifications
export const getDriverNotificationsHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    const result = await getNotifications(req.user!.userId);
    return res.status(200).json({ success: true, ...result, data: result.notifications });
  } catch (error) {
    return fail(res, error, {}, "driver.notifications_controller_error", "Failed to fetch notifications");
  }
};

// PATCH /api/drivers/notifications/:id/read (and :id/mark-read)
export const markDriverNotificationReadHandler = async (
  req: CustomAuthRequest & { params: { id: string } },
  res: Response
) => {
  try {
    const notification = await markNotificationRead(req.params.id, req.user!.userId);
    return res.status(200).json({ success: true, notification });
  } catch (error) {
    return fail(
      res,
      error,
      {
        NOTIFICATION_NOT_FOUND: [404, "Notification not found"],
        NOTIFICATION_NOT_OWNED: [404, "Notification not found"],
      },
      "driver.mark_notification_read_controller_error",
      "Failed to mark notification as read"
    );
  }
};

// PATCH /api/drivers/notifications/mark-all-read
export const markAllDriverNotificationsReadHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    const result = await markAllNotificationsRead(req.user!.userId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, {}, "driver.mark_all_notifications_read_controller_error", "Failed to mark notifications as read");
  }
};

// POST /api/drivers/card/unlink { pin }
export const unlinkDriverCardHandler = async (req: CustomAuthRequest, res: Response) => {
  const { pin } = req.body ?? {};
  if (!pin) return res.status(400).json({ success: false, message: "PIN is required" });

  try {
    return res.status(200).json(await unlinkDriverCard(req.user!.userId, String(pin).trim()));
  } catch (error) {
    return fail(
      res,
      error,
      {
        CARD_NOT_LINKED: [400, "No card is linked to this account."],
        INVALID_PIN_FORMAT: [400, "PIN must be exactly 4 digits"],
        INVALID_PIN: [400, "Incorrect PIN"],
        TOO_MANY_ATTEMPTS: [429, "Too many failed PIN attempts. Try again in 15 minutes."],
        ...DRIVER_NOT_FOUND,
      },
      "driver.card_unlink_controller_error"
    );
  }
};