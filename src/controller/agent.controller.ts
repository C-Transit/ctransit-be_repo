import type { Request, Response } from "express";
import logger from "../config/logger.js";
import { loginAgent } from "../services/agent.service.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import {
  getPendingKyc,
  approveKyc,
  rejectKyc,
} from "../services/kyc.service.js";
import {
  listDrivers,
  registerDriverByAgent,
} from "../services/driver.service.js";
import { listTerminals } from "../services/admin.service.js";
import { confirmRegistration } from "../services/registration.service.js";
import {
  getStudentsForAgent,
  getStudentTransactions,
} from "../services/user.service.js";
import { unlinkCard } from "../services/card.service.js";

// Safely extracts a single string from a query param.
function qs(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return undefined;
}

export const loginAgentHandler = async (
  req: Request<object, object, { email: string; password: string }>,
  res: Response
) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await loginAgent(email, password);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "INVALID_CREDENTIALS":
          return res.status(401).json({ error: "Invalid email or password" });

        case "AGENT_SUSPENDED":
          return res
            .status(403)
            .json({ error: "Agent account is temporarily suspended" });

        case "AGENT_DEACTIVATED":
          return res
            .status(403)
            .json({ error: "Agent account has been deactivated" });
      }
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.login_handler_error");
    return res.status(500).json({ error: "Login failed" });
  }
};

export const getPendingKycHandler = async (
  _req: CustomAuthRequest,
  res: Response
) => {
  try {
    const queue = await getPendingKyc();
    return res.status(200).json({ success: true, queue });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.route_get_pending_kyc_error");
    return res.status(500).json({ error: "Failed to fetch KYC queue" });
  }
};

export const approveAgentKycHandler = async (
  req: CustomAuthRequest & { params: { userId: string } },
  res: Response
) => {
  const { userId } = req.params;

  try {
    const kyc = await approveKyc(userId);
    logger.info(
      { userId, agentId: req.user!.userId },
      "agent.route_kyc_approved"
    );
    return res.status(200).json({ success: true, kyc });
  } catch (error) {
    if (error instanceof Error && error.message === "User not found") {
      return res.status(404).json({ error: "Student not found" });
    }
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage, userId }, "agent.route_kyc_approve_error");
    return res.status(500).json({ error: "Failed to approve KYC" });
  }
};

export const rejectAgentKycHandler = async (
  req: CustomAuthRequest & {
    params: { userId: string };
    body: { reason: string };
  },
  res: Response
) => {
  const { userId } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: "reason is required" });
  }

  try {
    const kyc = await rejectKyc(userId, reason);
    logger.info(
      { userId, agentId: req.user!.userId },
      "agent.route_kyc_rejected"
    );
    return res.status(200).json({ success: true, kyc });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage, userId }, "agent.route_kyc_reject_error");
    return res.status(500).json({ error: "Failed to reject KYC" });
  }
};

export const listDriversHandler = async (
  _req: CustomAuthRequest,
  res: Response
) => {
  try {
    const drivers = await listDrivers();
    return res.status(200).json({ success: true, drivers });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.route_list_drivers_error");
    return res.status(500).json({ error: "Failed to fetch drivers" });
  }
};

export const registerDriverHandler = async (
  req: CustomAuthRequest & {
    body: {
      firstname: string;
      lastname: string;
      phone: string;
      pin: string;
      otp: string;
      bankCode: string;
      accountNumber: string;
    };
  },
  res: Response
) => {
  const { firstname, lastname, phone, pin, otp, bankCode, accountNumber } =
    req.body;

  if (
    !firstname ||
    !lastname ||
    !phone ||
    !pin ||
    !otp ||
    !bankCode ||
    !accountNumber
  ) {
    return res.status(400).json({
      error:
        "firstname, lastname, phone, pin, otp, bankCode, and accountNumber are all required",
    });
  }

  try {
    const driver = await registerDriverByAgent({
      firstname,
      lastname,
      phone,
      pin,
      otp,
      bankCode,
      accountNumber,
    });
    logger.info(
      { matricNumber: driver.matricNumber, agentId: req.user!.userId },
      "agent.route_driver_registered"
    );
    return res.status(201).json({ success: true, driver });
  } catch (error) {
    if (error instanceof Error) {
      const knownErrors: Record<string, { status: number; message: string }> = {
        MISSING_NAME: {
          status: 400,
          message: "Firstname and lastname are required",
        },
        INVALID_PHONE: { status: 400, message: "Phone number is invalid" },
        INVALID_PIN_FORMAT: {
          status: 400,
          message: "PIN must be exactly 4 digits",
        },
        INVALID_OTP_FORMAT: {
          status: 400,
          message: "OTP must be exactly 6 digits",
        },
        MISSING_BANK_CODE: { status: 400, message: "Bank code is required" },
        INVALID_ACCOUNT_NUMBER: {
          status: 400,
          message: "Account number must be 10 digits",
        },
        PHONE_ALREADY_IN_USE: {
          status: 409,
          message: "This phone number is already registered",
        },
        INVALID_OTP: { status: 400, message: "OTP is invalid or unrecognized" },
        OTP_ALREADY_USED: {
          status: 409,
          message: "This OTP has already been used",
        },
        OTP_EXPIRED: {
          status: 410,
          message:
            "This OTP has expired — ask the driver to tap the card again",
        },
        MISSING_TERMINAL_CONTEXT: {
          status: 400,
          message: "OTP is missing terminal context",
        },
        CARD_ALREADY_LINKED: {
          status: 409,
          message: "This card is already linked to another user",
        },
        BANK_VERIFICATION_NOT_SUPPORTED: {
          status: 503,
          message: "Bank verification is currently unavailable",
        },
        DRIVER_UID_GENERATION_FAILED: {
          status: 500,
          message: "Failed to generate a driver ID — please try again",
        },
      };

      const known = knownErrors[error.message];
      if (known) {
        return res.status(known.status).json({ error: known.message });
      }
    }
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.route_register_driver_error");
    return res.status(500).json({ error: "Failed to register driver" });
  }
};

export const listTerminalsHandler = async (
  _req: CustomAuthRequest,
  res: Response
) => {
  try {
    const terminals = await listTerminals();
    return res.status(200).json({ success: true, terminals });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.route_list_terminals_error");
    return res.status(500).json({ error: "Failed to fetch terminals" });
  }
};

export const linkCardHandler = async (
  req: CustomAuthRequest & { body: { otp: string; studentId: string } },
  res: Response
) => {
  const { otp, studentId } = req.body;

  if (!otp || !studentId) {
    return res.status(400).json({ error: "otp and studentId are required" });
  }

  try {
    const result = await confirmRegistration(otp, studentId);

    if (result.success) {
      logger.info(
        { studentId, agentId: req.user!.userId },
        "agent.route_card_linked"
      );
      return res.status(200).json(result);
    }

    return res.status(400).json(result);
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage, studentId }, "agent.route_card_link_error");
    return res.status(500).json({ error: "Card linking failed" });
  }
};

export const listUsersHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  const rawVerified = qs(req.query.isVerified);
  const page = Math.max(1, parseInt(qs(req.query.page) ?? "1") || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(qs(req.query.limit) ?? "20") || 20)
  );

  const isVerified =
    rawVerified === "true" ? true : rawVerified === "false" ? false : undefined;

  try {
    const result = await getStudentsForAgent({ page, limit, isVerified });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.route_list_users_error");
    return res.status(500).json({ error: "Failed to fetch users" });
  }
};

export const getStudentTransactionsHandler = async (
  req: CustomAuthRequest & { params: { matricNumber: string } },
  res: Response
) => {
  const { matricNumber } = req.params;
  const page = Math.max(1, parseInt(qs(req.query.page) ?? "1") || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(qs(req.query.limit) ?? "20") || 20)
  );

  try {
    const result = await getStudentTransactions(matricNumber, {
      page,
      limit,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === "STUDENT_NOT_FOUND") {
      return res.status(404).json({ error: "Student not found" });
    }
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { err: errMessage, matricNumber },
      "agent.route_student_transactions_error"
    );
    return res.status(500).json({ error: "Failed to fetch transactions" });
  }
};

export const unlinkCardAgentHandler = async (
  req: CustomAuthRequest,
  res: Response
) => {
  try {
    if (!req.user || (req.user.role !== "AGENT" && req.user.role !== "ADMIN")) {
      return res
        .status(403)
        .json({ success: false, message: "Agent access required" });
    }

    const { cardUid, userIdentifier } = req.body;
    if (!cardUid && !userIdentifier) {
      return res.status(400).json({
        success: false,
        message: "Either cardUid or userIdentifier must be provided",
      });
    }

    const result = await unlinkCard({
      cardUid: cardUid ? String(cardUid).trim() : undefined,
      userIdentifier: userIdentifier
        ? String(userIdentifier).trim()
        : undefined,
      callerId: req.user.userId,
      callerRole: req.user.role,
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "CARD_NOT_FOUND":
          return res
            .status(404)
            .json({ success: false, message: "Card mapping not found" });
        case "USER_NOT_FOUND":
          return res
            .status(404)
            .json({ success: false, message: "User not found" });
        case "CARD_ALREADY_UNLINKED":
          return res
            .status(400)
            .json({
              success: false,
              message: "No active card is linked to this user",
            });
        case "CARD_USER_MISMATCH":
        case "CARD_BELONGS_TO_ANOTHER_USER":
          return res
            .status(400)
            .json({
              success: false,
              message: "Card does not belong to the specified user",
            });
        case "UNAUTHORIZED_CALLER":
          return res
            .status(403)
            .json({ success: false, message: "Unauthorized to unlink card" });
      }
    }

    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.unlink_card_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
