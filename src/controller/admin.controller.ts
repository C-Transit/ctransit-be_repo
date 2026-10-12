import type { Request, Response } from "express";
import type { AgentStatus } from "@prisma/client";
import logger from "../config/logger.js";
import { enqueueSyncWhitelist } from "../utils/bridge.js";
import { buildChunks } from "../utils/parser.js";
import { prisma } from "../lib/prisma.js";
import { type CustomAuthRequest } from "../middleware/auth.middleware.js";
import {
  createAgent,
  updateAgentStatus,
  listAgents,
  getAgentById,
  listTerminals,
  getAdminOverview,
  getIncomeStats,
  listDisputes,
  getDisputeById,
  updateDisputeStatus,
  sendNotification,
  linkAdminCard,
} from "../services/admin.service.js";
import { unlinkCard } from "../services/card.service.js";

type ErrorTable = Record<string, [status: number, message: string]>;

// Maps a known service error to its response, otherwise logs and returns a generic 500.
// `wrap` selects the body shape: { error } (default) or { success: false, message }.
function fail(
  res: Response,
  error: unknown,
  table: ErrorTable,
  event: string,
  fallback: string,
  wrap: "error" | "message" = "error",
  ctx: object = {}
) {
  const code = error instanceof Error ? error.message : "";
  const body = (msg: string) => (wrap === "error" ? { error: msg } : { success: false, message: msg });

  const known = table[code];
  if (known) return res.status(known[0]).json(body(known[1]));

  logger.error({ err: code || "Unknown error", ...ctx }, event);
  return res.status(500).json(body(fallback));
}

// Safely extracts a single string from a query parameter.
function qs(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return undefined;
}

const paging = (req: CustomAuthRequest) => ({
  page: Math.max(1, parseInt(qs(req.query.page) ?? "1") || 1),
  limit: Math.min(100, Math.max(1, parseInt(qs(req.query.limit) ?? "20") || 20)),
});

const VALID_AGENT_STATUSES: AgentStatus[] = ["ACTIVE", "SUSPENDED", "DEACTIVATED"];
const VALID_DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED"] as const;
type ValidDisputeStatus = (typeof VALID_DISPUTE_STATUSES)[number];

const invalidStatus = (valid: readonly string[]) => `Invalid status. Must be one of: ${valid.join(", ")}`;

export const createAgentHandler = async (req: CustomAuthRequest, res: Response) => {
  const { firstname, lastname, email, phone, password } = req.body ?? {};
  if (!firstname || !lastname || !email || !phone || !password) {
    return res.status(400).json({ error: "firstname, lastname, email, phone, and password are required" });
  }

  const adminId = req.user!.userId;
  try {
    const agent = await createAgent(
      {
        firstname: String(firstname),
        lastname: String(lastname),
        email: String(email),
        phone: String(phone),
        password: String(password),
      },
      adminId
    );
    logger.info({ agentId: agent.id, adminId }, "admin.route_agent_created");
    return res.status(201).json({ success: true, agent });
  } catch (error) {
    return fail(
      res,
      error,
      { EMAIL_ALREADY_IN_USE: [409, "An agent with this email already exists"] },
      "admin.route_create_agent_error",
      "Failed to create agent"
    );
  }
};

export const listAgentsHandler = async (req: CustomAuthRequest, res: Response) => {
  const rawStatus = qs(req.query.status);
  if (rawStatus && !VALID_AGENT_STATUSES.includes(rawStatus as AgentStatus)) {
    return res.status(400).json({ error: invalidStatus(VALID_AGENT_STATUSES) });
  }

  try {
    const result = await listAgents({ status: rawStatus as AgentStatus | undefined, ...paging(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, {}, "admin.route_list_agents_error", "Failed to fetch agents");
  }
};

export const getAgentByIdHandler = async (
  req: CustomAuthRequest & { params: { id: string } },
  res: Response
) => {
  const { id } = req.params;
  try {
    return res.status(200).json({ success: true, agent: await getAgentById(id) });
  } catch (error) {
    return fail(
      res,
      error,
      { AGENT_NOT_FOUND: [404, "Agent not found"] },
      "admin.route_get_agent_error",
      "Failed to fetch agent",
      "error",
      { agentId: id }
    );
  }
};

export const updateAgentStatusHandler = async (
  req: CustomAuthRequest & { params: { id: string } },
  res: Response
) => {
  const { id } = req.params;
  const status = req.body?.status;
  if (!status) return res.status(400).json({ error: "status is required" });
  if (!VALID_AGENT_STATUSES.includes(status as AgentStatus)) {
    return res.status(400).json({ error: invalidStatus(VALID_AGENT_STATUSES) });
  }

  const adminId = req.user!.userId;
  try {
    const agent = await updateAgentStatus(id, status as AgentStatus);
    logger.info({ agentId: id, newStatus: status, adminId }, "admin.route_agent_status_updated");
    return res.status(200).json({ success: true, agent });
  } catch (error) {
    return fail(
      res,
      error,
      {
        AGENT_NOT_FOUND: [404, "Agent not found"],
        AGENT_ALREADY_IN_STATUS: [409, "Agent is already in that status"],
        CANNOT_TRANSITION_FROM_DEACTIVATED: [409, "A deactivated agent can only be set to ACTIVE, not SUSPENDED"],
      },
      "admin.route_update_agent_status_error",
      "Failed to update agent status",
      "error",
      { agentId: id }
    );
  }
};

export const getAdminOverviewHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, overview: await getAdminOverview() });
  } catch (error) {
    return fail(res, error, {}, "admin.route_overview_error", "Failed to fetch overview");
  }
};

export const getIncomeStatsHandler = async (req: CustomAuthRequest, res: Response) => {
  const rawFrom = qs(req.query.from);
  const rawTo = qs(req.query.to);
  const from = rawFrom ? new Date(rawFrom) : undefined;
  const to = rawTo ? new Date(rawTo) : undefined;

  if (from && isNaN(from.getTime())) return res.status(400).json({ error: "Invalid 'from' date format" });
  if (to && isNaN(to.getTime())) return res.status(400).json({ error: "Invalid 'to' date format" });

  try {
    const stats = await getIncomeStats({
      from,
      to,
      terminalId: qs(req.query.terminalId),
      driverUid: qs(req.query.driverUid),
    });
    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return fail(res, error, {}, "admin.route_income_error", "Failed to fetch income stats");
  }
};

export const listTerminalsHandler = async (_req: CustomAuthRequest, res: Response) => {
  try {
    return res.status(200).json({ success: true, terminals: await listTerminals() });
  } catch (error) {
    return fail(res, error, {}, "admin.route_terminals_error", "Failed to fetch terminals");
  }
};

export const listDisputesHandler = async (req: CustomAuthRequest, res: Response) => {
  const rawStatus = qs(req.query.status);
  if (rawStatus && !VALID_DISPUTE_STATUSES.includes(rawStatus as ValidDisputeStatus)) {
    return res.status(400).json({ error: invalidStatus(VALID_DISPUTE_STATUSES) });
  }

  try {
    const result = await listDisputes({ status: rawStatus as ValidDisputeStatus | undefined, ...paging(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, {}, "admin.route_list_disputes_error", "Failed to fetch disputes");
  }
};

export const getDisputeByIdHandler = async (
  req: CustomAuthRequest & { params: { id: string } },
  res: Response
) => {
  const { id } = req.params;
  try {
    return res.status(200).json({ success: true, dispute: await getDisputeById(id) });
  } catch (error) {
    return fail(
      res,
      error,
      { DISPUTE_NOT_FOUND: [404, "Dispute not found"] },
      "admin.route_get_dispute_error",
      "Failed to fetch dispute",
      "error",
      { disputeId: id }
    );
  }
};

export const updateDisputeStatusHandler = async (
  req: CustomAuthRequest & { params: { id: string } },
  res: Response
) => {
  const { id } = req.params;
  const { status, resolution } = req.body ?? {};
  if (!status) return res.status(400).json({ error: "status is required" });
  if (!VALID_DISPUTE_STATUSES.includes(status as ValidDisputeStatus)) {
    return res.status(400).json({ error: invalidStatus(VALID_DISPUTE_STATUSES) });
  }

  const adminId = req.user!.userId;
  try {
    const dispute = await updateDisputeStatus(id, {
      newStatus: status as ValidDisputeStatus,
      resolution: resolution ? String(resolution) : undefined,
      adminId,
    });
    logger.info({ disputeId: id, newStatus: status, adminId }, "admin.route_dispute_status_updated");
    return res.status(200).json({ success: true, dispute });
  } catch (error) {
    return fail(
      res,
      error,
      {
        DISPUTE_NOT_FOUND: [404, "Dispute not found"],
        DISPUTE_ALREADY_CLOSED: [409, "Dispute is already resolved or rejected"],
        RESOLUTION_REQUIRED: [400, "resolution text is required when closing a dispute"],
      },
      "admin.route_update_dispute_error",
      "Failed to update dispute",
      "error",
      { disputeId: id }
    );
  }
};

export const sendNotificationHandler = async (req: CustomAuthRequest, res: Response) => {
  const { studentMatric, title, body } = req.body ?? {};
  if (!studentMatric || !title || !body) {
    return res.status(400).json({ error: "studentMatric, title, and body are required" });
  }

  try {
    const notification = await sendNotification(String(studentMatric), String(title), String(body));
    logger.info({ studentMatric, adminId: req.user!.userId }, "admin.route_notification_sent");
    return res.status(201).json({ success: true, notification });
  } catch (error) {
    return fail(
      res,
      error,
      { STUDENT_NOT_FOUND: [404, "Student not found"] },
      "admin.route_send_notification_error",
      "Failed to send notification"
    );
  }
};

export const syncWhitelistHandler = async (_req: Request, res: Response) => {
  try {
    const cards = await prisma.cardMapping.findMany({ select: { card_uid: true } });
    const uids = cards.map((c) => c.card_uid);

    const chunks = uids.length === 0 ? ["SYS:WL,EMPTY"] : buildChunks("SYS:WL,", uids, 500);
    logger.info({ cardCount: uids.length, chunkCount: chunks.length }, "admin.sync_whitelist_initiated");

    await enqueueSyncWhitelist(chunks);
    return res.json({
      success: true,
      message: `Whitelist sync queued for fleet. ${uids.length} card(s), ${chunks.length} chunk(s).`,
    });
  } catch (error) {
    return fail(res, error, {}, "admin.sync_whitelist_error", "Failed to queue whitelist sync");
  }
};

export const unlinkCardAdminHandler = async (req: CustomAuthRequest, res: Response) => {
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
    return fail(
      res,
      error,
      {
        CARD_NOT_FOUND: [404, "Card mapping not found"],
        USER_NOT_FOUND: [404, "User not found"],
        CARD_ALREADY_UNLINKED: [400, "No active card is linked to this user"],
        CARD_USER_MISMATCH: [400, "Card does not belong to the specified user"],
        CARD_BELONGS_TO_ANOTHER_USER: [400, "Card does not belong to the specified user"],
        UNAUTHORIZED_CALLER: [403, "Unauthorized to unlink card"],
      },
      "admin.unlink_card_controller_error",
      "Server error",
      "message"
    );
  }
};

export const linkAdminCardHandler = async (req: CustomAuthRequest, res: Response) => {
  const { otp, pin } = req.body ?? {};
  if (!otp || !pin) {
    return res.status(400).json({ success: false, message: "otp and pin are required" });
  }

  try {
    const result = await linkAdminCard(req.user!.userId, {
      otp: String(otp).trim(),
      pin: String(pin).trim(),
    });
    return res.status(200).json(result);
  } catch (error) {
    return fail(
      res,
      error,
      {
        ADMIN_NOT_FOUND: [404, "Admin account not found"],
        INVALID_OTP_FORMAT: [400, "OTP must be exactly 6 digits"],
        INVALID_PIN_FORMAT: [400, "PIN must be exactly 4 digits"],
        INVALID_OTP: [400, "OTP is invalid or unrecognized"],
        OTP_ALREADY_USED: [409, "This OTP has already been used"],
        OTP_EXPIRED: [410, "This OTP has expired — tap your card again"],
        MISSING_TERMINAL_CONTEXT: [400, "OTP is missing terminal context"],
        CARD_ALREADY_LINKED: [409, "This card is already linked to another user"],
        ADMIN_ALREADY_HAS_CARD: [409, "Your account already has a different card linked"],
      },
      "admin.link_card_controller_error",
      "Server error",
      "message"
    );
  }
};