import { type Request, type Response } from "express";
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
} from "../services/driver.service.js";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../services/notification.service.js";

// POST /api/drivers/login
export const loginDriverHandler = async (req: Request, res: Response) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide identifier (email or driver ID) and password",
      });
    }

    const result = await loginDriver(identifier, password);

    return res.status(200).json({
      success: true,
      token: result.accessToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      driver: result.driver,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_CREDENTIALS") {
      return res.status(401).json({
        success: false,
        message: "Invalid email/driver ID or password",
      });
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.login_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/drivers/me
export const getDriverMeHandler = async (req: CustomAuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const profile = await getDriverProfile(userId);

    return res.status(200).json({
      success: true,
      ...profile,
      driver: profile,
      data: profile,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DRIVER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Driver not found" });
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.me_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/drivers/dashboard
export const getDriverDashboardHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const dashboard = await getDriverDashboard(userId);

    return res.status(200).json({
      success: true,
      ...dashboard,
      data: dashboard,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DRIVER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Driver not found" });
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.dashboard_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/drivers/rides
export const getDriverRidesHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;

    const result = await getDriverRides(userId, page, limit);

    return res.status(200).json({
      success: true,
      data: result.rides,
      rides: result.rides,
      pagination: result.pagination,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DRIVER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Driver not found" });
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.rides_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /api/drivers/withdraw
export const createDriverWithdrawalHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { amount, bankName, accountNumber, accountName, remarks } = req.body;

    const parsedAmount = typeof amount === "number" ? amount : parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please specify a valid positive withdrawal amount",
      });
    }

    const result = await createDriverWithdrawal(userId, {
      amount: parsedAmount,
      bankName: bankName ? String(bankName).trim() : undefined,
      accountNumber: accountNumber ? String(accountNumber).trim() : undefined,
      accountName: accountName ? String(accountName).trim() : undefined,
      remarks: remarks ? String(remarks).trim() : undefined,
    });

    return res.status(201).json({
      success: true,
      message: "Withdrawal request submitted successfully",
      data: result,
      withdrawal: result,
    });
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "BANK_NOT_VERIFIED":
          return res.status(400).json({
            success: false,
            message:
              "Bank account must be verified before initiating withdrawals. Please verify your bank account first.",
          });
        case "INSUFFICIENT_BALANCE":
          return res.status(400).json({
            success: false,
            message: "Withdrawal amount exceeds available balance",
          });
        case "INVALID_AMOUNT":
          return res.status(400).json({
            success: false,
            message: "Please specify a valid positive withdrawal amount",
          });
        case "AMOUNT_TOO_LOW":
          return res.status(400).json({
            success: false,
            message: "Withdrawal amount is too low after fees",
          });
        case "MISSING_BANK_DETAILS":
          return res.status(400).json({
            success: false,
            message: "Bank name and account number are required",
          });
        case "WALLET_NOT_FOUND":
          return res.status(404).json({
            success: false,
            message: "Driver wallet not found",
          });
        case "DRIVER_NOT_FOUND":
          return res.status(404).json({
            success: false,
            message: "Driver not found",
          });
      }
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.withdraw_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/drivers/withdrawals
export const getDriverWithdrawalsHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;

    const result = await getDriverWithdrawals(userId, page, limit);

    return res.status(200).json({
      success: true,
      data: result.withdrawals,
      withdrawals: result.withdrawals,
      pagination: result.pagination,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DRIVER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Driver not found" });
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.withdrawals_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /api/drivers/card/link
export const linkDriverCardHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { otp, cardUid, driverId } = req.body;

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: "OTP is required",
      });
    }

    const result = await linkDriverCard(userId, {
      otp: String(otp).trim(),
      cardUid: cardUid ? String(cardUid).trim() : undefined,
      driverId: driverId ? String(driverId).trim() : undefined,
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "CARD_ALREADY_LINKED":
          return res.status(409).json({
            success: false,
            message: "Physical card is already linked to another user.",
          });
        case "DRIVER_ALREADY_HAS_CARD":
          return res.status(400).json({
            success: false,
            message:
              "Driver already has a linked physical card. Please unlink the existing card first.",
          });
        case "MISSING_TERMINAL_CONTEXT":
          return res.status(400).json({
            success: false,
            message: "Registration OTP is missing origin terminal context.",
          });
        case "UNAUTHORIZED_DRIVER_ID":
          return res.status(403).json({
            success: false,
            message: "You can only link a card to your own driver account",
          });
        case "INVALID_OTP_FORMAT":
          return res.status(400).json({
            success: false,
            message: "OTP must be exactly 6 digits",
          });
        case "INVALID_OTP":
          return res.status(400).json({
            success: false,
            message: "Invalid OTP. Please tap your card again.",
          });
        case "CARD_MISMATCH":
          return res.status(400).json({
            success: false,
            message: "Card UID does not match OTP registration.",
          });
        case "OTP_ALREADY_USED":
          return res.status(400).json({
            success: false,
            message:
              "This OTP has already been used. Please tap your card again for a new OTP.",
          });
        case "OTP_EXPIRED":
          return res.status(400).json({
            success: false,
            message: "OTP has expired. Please tap your card again.",
          });
        case "DRIVER_NOT_FOUND":
          return res.status(404).json({
            success: false,
            message: "Driver not found",
          });
      }
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.card_link_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/drivers/notifications
export const getDriverNotificationsHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const result = await getNotifications(userId);
    return res.status(200).json({
      success: true,
      ...result,
      data: result.notifications,
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.notifications_controller_error");
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch notifications" });
  }
};

// PATCH /api/drivers/notifications/:id/read (and :id/mark-read)
export const markDriverNotificationReadHandler = async (
  req: CustomAuthRequest & { params: { id: string } },
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { id } = req.params;
    const notification = await markNotificationRead(id, userId);
    return res.status(200).json({ success: true, notification });
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message === "NOTIFICATION_NOT_FOUND" ||
        error.message === "NOTIFICATION_NOT_OWNED"
      ) {
        return res
          .status(404)
          .json({ success: false, message: "Notification not found" });
      }
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { err: errMessage, notificationId: req.params.id },
      "driver.mark_notification_read_controller_error"
    );
    return res
      .status(500)
      .json({ success: false, message: "Failed to mark notification as read" });
  }
};

// PATCH /api/drivers/notifications/mark-all-read
export const markAllDriverNotificationsReadHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const result = await markAllNotificationsRead(userId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { err: errMessage },
      "driver.mark_all_notifications_read_controller_error"
    );
    return res
      .status(500)
      .json({ success: false, message: "Failed to mark notifications as read" });
  }
};

// POST /api/drivers/card/pin
export const setDriverCardPinHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { pin } = req.body;
    if (!pin) {
      return res.status(400).json({
        success: false,
        message: "PIN is required",
      });
    }

    const result = await setDriverCardPin(userId, {
      pin: String(pin).trim(),
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "CARD_NOT_LINKED":
          return res.status(400).json({
            success: false,
            message:
              "Driver must link a physical card before setting a terminal PIN.",
          });
        case "INVALID_PIN_FORMAT":
          return res.status(400).json({
            success: false,
            message: "PIN must be 4 to 6 numeric digits.",
          });
        case "DRIVER_NOT_FOUND":
          return res.status(404).json({
            success: false,
            message: "Driver not found",
          });
      }
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.pin_set_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/drivers/card/pin/status
export const getDriverPinStatusHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const result = await getDriverPinStatus(userId);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "DRIVER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "Driver not found" });
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.pin_status_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /api/drivers/bank/verify
export const verifyDriverBankHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { bankCode, accountNumber } = req.body;
    if (!bankCode || !accountNumber) {
      return res.status(400).json({
        success: false,
        message: "Both bankCode and accountNumber are required",
      });
    }

    const result = await verifyAndSaveDriverBank(userId, {
      bankCode: String(bankCode).trim(),
      accountNumber: String(accountNumber).trim(),
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "MISSING_BANK_CODE":
          return res.status(400).json({
            success: false,
            message: "Bank code is required",
          });
        case "INVALID_ACCOUNT_NUMBER":
          return res.status(400).json({
            success: false,
            message: "Account number must be exactly 10 digits",
          });
        case "DRIVER_NOT_FOUND":
          return res.status(404).json({
            success: false,
            message: "Driver not found",
          });
        case "BANK_VERIFICATION_NOT_SUPPORTED":
          return res.status(501).json({
            success: false,
            message: "Bank account resolution is not supported by payment provider",
          });
        default:
          return res.status(400).json({
            success: false,
            message: error.message || "Failed to resolve bank account details",
          });
      }
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "driver.bank_verify_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

