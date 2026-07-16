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

    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.login_handler_error");
    return res.status(500).json({ error: "Login failed" });
  }
};

export const getPendingKycHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    const queue = await getPendingKyc();
    return res.status(200).json({ success: true, queue });
  } catch (error) {
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
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
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
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
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage, userId }, "agent.route_kyc_reject_error");
    return res.status(500).json({ error: "Failed to reject KYC" });
  }
};

export const listDriversHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    const drivers = await listDrivers();
    return res.status(200).json({ success: true, drivers });
  } catch (error) {
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.route_list_drivers_error");
    return res.status(500).json({ error: "Failed to fetch drivers" });
  }
};

export const registerDriverHandler = async (
  req: CustomAuthRequest & {
    body: { firstname: string; lastname: string; matricNumber: string };
  },
  res: Response
) => {
  const { firstname, lastname, matricNumber } = req.body;

  if (!firstname || !lastname || !matricNumber) {
    return res
      .status(400)
      .json({ error: "firstname, lastname, and matricNumber are required" });
  }

  try {
    const driver = await registerDriverByAgent({
      firstname,
      lastname,
      matricNumber,
    });
    logger.info(
      { matricNumber: driver.matricNumber, agentId: req.user!.userId },
      "agent.route_driver_registered"
    );
    return res.status(201).json({ success: true, driver });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "DRIVER_ALREADY_EXISTS") {
        return res
          .status(409)
          .json({ error: "A driver with this matric number already exists" });
      }
      if (error.message === "MATRIC_NUMBER_IN_USE") {
        return res.status(409).json({
          error: "Matric number is already registered to another user",
        });
      }
    }
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "agent.route_register_driver_error");
    return res.status(500).json({ error: "Failed to register driver" });
  }
};

export const listTerminalsHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    const terminals = await listTerminals();
    return res.status(200).json({ success: true, terminals });
  } catch (error) {
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
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
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage, studentId }, "agent.route_card_link_error");
    return res.status(500).json({ error: "Card linking failed" });
  }
};

export const listUsersHandler = async (req: CustomAuthRequest, res: Response) => {
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
    const errMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { err: errMessage, matricNumber },
      "agent.route_student_transactions_error"
    );
    return res.status(500).json({ error: "Failed to fetch transactions" });
  }
};
