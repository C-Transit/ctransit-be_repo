import type { Request, Response } from "express";
import logger from "../config/logger.js";
import { loginAgent } from "../services/agent.service.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import { getPendingKyc, approveKyc, rejectKyc } from "../services/kyc.service.js";
import { listDrivers, registerDriverByAgent } from "../services/driver.service.js";
import { listTerminals } from "../services/admin.service.js";
import { confirmRegistration } from "../services/registration.service.js";
import { getStudentsForAgent, getStudentTransactions } from "../services/user.service.js";
import { unlinkCard } from "../services/card.service.js";

type ErrorTable = Record<string, [status: number, message: string]>;

// Maps a known service error to its response, otherwise logs and returns a generic 500.
// Agent endpoints respond with { error } bodies.
function fail(res: Response, error: unknown, table: ErrorTable, event: string, fallback: string, ctx: object = {}) {
  const code = error instanceof Error ? error.message : "";
  const known = table[code];
  if (known) return res.status(known[0]).json({ error: known[1] });

  logger.error({ err: code || "Unknown error", ...ctx }, event);
  return res.status(500).json({ error: fallback });
}

// Safely extracts a single string from a query param.
function qs(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return undefined;
}

const paging = (req: CustomAuthRequest) => ({
  page: Math.max(1, parseInt(qs(req.query.page) ?? "1") || 1),
  limit: Math.min(100, Math.max(1, parseInt(qs(req.query.limit) ?? "20") || 20)),
});

const KYC_NOT_FOUND: ErrorTable = {
  USER_NOT_FOUND: [404, "Student not found"],
  KYC_NOT_FOUND: [404, "No KYC record found for this student"],
};

export const loginAgentHandler = async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await loginAgent(String(email), String(password));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(
      res,
      error,
      {
        INVALID_CREDENTIALS: [401, "Invalid email or password"],
        AGENT_SUSPENDED: [403, "Agent account is temporarily suspended"],
        AGENT_DEACTIVATED: [403, "Agent account has been deactivated"],
        TOO_MANY_ATTEMPTS: [429, "Too many failed attempts. Try again in 15 minutes."],
      },
      "agent.login_handler_error",
      "Login failed"
    );
  }
};

export const getPendingKycHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, queue: await getPendingKyc() });
  } catch (error) {
    return fail(res, error, {}, "agent.route_get_pending_kyc_error", "Failed to fetch KYC queue");
  }
};

export const approveAgentKycHandler = async (
  req: CustomAuthRequest & { params: { userId: string } },
  res: Response
) => {
  const { userId } = req.params;

  try {
    const kyc = await approveKyc(userId);
    logger.info({ userId, agentId: req.user!.userId }, "agent.route_kyc_approved");
    return res.status(200).json({ success: true, kyc });
  } catch (error) {
    return fail(res, error, KYC_NOT_FOUND, "agent.route_kyc_approve_error", "Failed to approve KYC", { userId });
  }
};

export const rejectAgentKycHandler = async (
  req: CustomAuthRequest & { params: { userId: string }; body: { reason: string } },
  res: Response
) => {
  const { userId } = req.params;
  const reason = req.body?.reason;
  if (!reason) return res.status(400).json({ error: "reason is required" });

  try {
    const kyc = await rejectKyc(userId, String(reason));
    logger.info({ userId, agentId: req.user!.userId }, "agent.route_kyc_rejected");
    return res.status(200).json({ success: true, kyc });
  } catch (error) {
    return fail(res, error, KYC_NOT_FOUND, "agent.route_kyc_reject_error", "Failed to reject KYC", { userId });
  }
};

export const listDriversHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, drivers: await listDrivers() });
  } catch (error) {
    return fail(res, error, {}, "agent.route_list_drivers_error", "Failed to fetch drivers");
  }
};

export const registerDriverHandler = async (req: CustomAuthRequest, res: Response) => {
  const { firstname, lastname, phone, pin } = req.body ?? {};
  if (!firstname || !lastname || !phone || !pin) {
    return res.status(400).json({ error: "firstname, lastname, phone, and pin are all required" });
  }

  try {
    const driver = await registerDriverByAgent({
      firstname: String(firstname),
      lastname: String(lastname),
      phone: String(phone),
      pin: String(pin),
    });
    logger.info({ agentId: req.user!.userId }, "agent.route_driver_registered");
    return res.status(201).json({ success: true, driver });
  } catch (error) {
    return fail(
      res,
      error,
      {
        MISSING_NAME: [400, "Firstname and lastname are required"],
        INVALID_PHONE: [400, "Phone number is invalid"],
        INVALID_PIN_FORMAT: [400, "PIN must be exactly 4 digits"],
        PHONE_ALREADY_IN_USE: [409, "This phone number is already registered"],
        DRIVER_UID_GENERATION_FAILED: [500, "Failed to generate a driver ID — please try again"],
      },
      "agent.route_register_driver_error",
      "Failed to register driver"
    );
  }
};

export const listTerminalsHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, terminals: await listTerminals() });
  } catch (error) {
    return fail(res, error, {}, "agent.route_list_terminals_error", "Failed to fetch terminals");
  }
};

export const linkCardHandler = async (req: CustomAuthRequest, res: Response) => {
  const { otp, studentId } = req.body ?? {};
  if (!otp || !studentId) {
    return res.status(400).json({ error: "otp and studentId are required" });
  }

  try {
    const result = await confirmRegistration(String(otp), String(studentId));
    if (result.success) {
      logger.info({ studentId, agentId: req.user!.userId }, "agent.route_card_linked");
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return fail(res, error, {}, "agent.route_card_link_error", "Card linking failed", { studentId });
  }
};

export const listUsersHandler = async (req: CustomAuthRequest, res: Response) => {
  const rawVerified = qs(req.query.isVerified);
  const isVerified = rawVerified === "true" ? true : rawVerified === "false" ? false : undefined;

  try {
    const result = await getStudentsForAgent({ ...paging(req), isVerified });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, {}, "agent.route_list_users_error", "Failed to fetch users");
  }
};

export const getStudentTransactionsHandler = async (
  req: CustomAuthRequest & { params: { matricNumber: string } },
  res: Response
) => {
  const { matricNumber } = req.params;

  try {
    const result = await getStudentTransactions(matricNumber, paging(req));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(
      res,
      error,
      { STUDENT_NOT_FOUND: [404, "Student not found"] },
      "agent.route_student_transactions_error",
      "Failed to fetch transactions",
      { matricNumber }
    );
  }
};

// Unlink responses use { success, message } bodies, unlike the rest of this controller.
const UNLINK_ERRORS: Record<string, [number, string]> = {
  CARD_NOT_FOUND: [404, "Card mapping not found"],
  USER_NOT_FOUND: [404, "User not found"],
  CARD_ALREADY_UNLINKED: [400, "No active card is linked to this user"],
  CARD_USER_MISMATCH: [400, "Card does not belong to the specified user"],
  CARD_BELONGS_TO_ANOTHER_USER: [400, "Card does not belong to the specified user"],
  UNAUTHORIZED_CALLER: [403, "Unauthorized to unlink card"],
};

export const unlinkCardAgentHandler = async (req: CustomAuthRequest, res: Response) => {
  const { cardUid, userIdentifier } = req.body ?? {};
  if (!cardUid && !userIdentifier) {
    return res.status(400).json({
      success: false,
      message: "Either cardUid or userIdentifier must be provided",
    });
  }

  try {
    const result = await unlinkCard({
      cardUid: cardUid ? String(cardUid).trim() : undefined,
      userIdentifier: userIdentifier ? String(userIdentifier).trim() : undefined,
      callerId: req.user!.userId,
      callerRole: req.user!.role,
    });
    return res.status(200).json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const known = UNLINK_ERRORS[code];
    if (known) return res.status(known[0]).json({ success: false, message: known[1] });

    logger.error({ err: code || "Unknown error" }, "agent.unlink_card_controller_error");
    return res.status(500).json({ success: false, message: "Server error" });
  }
};