import express from "express";
import { type Request, type Response, type NextFunction } from "express";
import logger from "../config/logger.js";
import env from "../config/env.js";
import { invalidateTerminalSecretCache } from "../services/hmac.service.js";
import {
  enqueueRoute,
  enqueueBroadcast,
} from "../utils/bridge.js";
import { confirmRegistration } from "../services/registration.service.js";
import {
  creditWallet,
  hasCrossedAboveThreshold,
  prisma,
} from "../services/ledger.service.js";
import { buildDeltaCommand } from "../utils/parser.js";
import { getRedisClient, redisKeys } from "../config/redis.js";
import { approveKyc, rejectKyc } from "../services/kyc.service.js";
import {
  authenticateToken,
  requireAdmin,
  type CustomAuthRequest,
} from "../middleware/auth.middleware.js";
import { type AgentStatus } from "@prisma/client";
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
} from "../services/admin.service.js";

const router = express.Router();

function requireAdminSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== env.admin.secret) {
    logger.warn({ ip: req.ip, path: req.path }, "admin.unauthorized_request");
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.use(requireAdminSecret);

router.post(
  "/poison-pill",
  async (
    req: Request<object, object, { terminalId: string }>,
    res: Response
  ) => {
    const { terminalId } = req.body;
    if (!terminalId) {
      return res.status(400).json({ error: "terminalId is required" });
    }

    const log = logger.child({ terminalId });

    try {
      await prisma.terminal.update({
        where: { terminal_id: terminalId },
        data: { status: "LOCKED" },
      });

      const poisonCmd = "CMD:POISON_PILL";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis = getRedisClient() as any;
      await redis.lpush(redisKeys.terminalQueue(terminalId), poisonCmd);
      await enqueueRoute(terminalId, poisonCmd);

      log.warn({ poisonCmd }, "admin.poison_pill_queued");
      res.json({
        success: true,
        message: `Poison pill queued for ${terminalId}`,
      });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      log.error({ err: errMessage }, "admin.poison_pill_error");
      res.status(500).json({ error: "Failed to issue poison pill" });
    }
  }
);

router.post(
  "/ota",
  async (
    req: Request<object, object, { firmwareUrl: string }>,
    res: Response
  ) => {
    const { firmwareUrl } = req.body;

    if (!firmwareUrl || !firmwareUrl.startsWith("https://")) {
      return res
        .status(400)
        .json({ error: "firmwareUrl must be a valid HTTPS URL" });
    }

    const otaCmd = `CMD:OTA,${firmwareUrl}`;
    logger.info({ firmwareUrl }, "admin.ota_broadcast_initiated");

    try {
      await enqueueBroadcast(otaCmd);
      res.json({ success: true, message: "OTA command broadcast to fleet" });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.ota_broadcast_error");
      res.status(500).json({ error: "OTA broadcast failed" });
    }
  }
);

router.post(
  "/confirm-registration",
  async (
    req: Request<object, object, { otp: string; studentId: string }>,
    res: Response
  ) => {
    const { otp, studentId } = req.body;

    if (!otp || !studentId) {
      return res.status(400).json({
        success: false,
        message:
          "Both otp and studentId are required for agent-assisted linking",
      });
    }

    try {
      const result = await confirmRegistration(otp, studentId);

      if (result.success) {
        logger.info(
          { agentIp: req.ip, studentId },
          "admin.agent_linked_card_success"
        );
        return res.status(200).json(result);
      }

      return res.status(400).json(result);
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.agent_link_error");
      return res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  }
);

router.post(
  "/monnify-webhook",
  async (
    req: Request<
      object,
      object,
      { studentUid: string; amount: string | number }
    >,
    res: Response
  ) => {
    res.status(200).json({ received: true });

    const { studentUid, amount } = req.body;
    const log = logger.child({ studentUid, amount });
    const parsedAmount =
      typeof amount === "string" ? parseFloat(amount) : amount;

    if (!studentUid || !amount || isNaN(parsedAmount)) {
      log.warn("admin.monnify_webhook_invalid_payload");
      return;
    }

    try {
      const result = await creditWallet(studentUid, parsedAmount);

      if (!result) {
        log.warn("admin.monnify_webhook_wallet_not_found");
        return;
      }

      const { previousBalance, newBalance } = result;

      if (hasCrossedAboveThreshold(previousBalance, newBalance)) {
        const removeBlCmd = buildDeltaCommand("REM", "BL", studentUid);
        log.info(
          { removeBlCmd, previousBalance, newBalance },
          "admin.monnify_threshold_crossed"
        );
        await enqueueBroadcast(removeBlCmd);
      }
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      log.error({ err: errMessage }, "admin.monnify_webhook_processing_error");
    }
  }
);

router.post(
  "/terminal/register",
  async (
    req: Request<object, object, { terminalId: string; secretKey: string }>,
    res: Response
  ) => {
    const { terminalId, secretKey } = req.body;

    if (!terminalId || !secretKey) {
      return res
        .status(400)
        .json({ error: "terminalId and secretKey are required" });
    }

    try {
      const terminal = await prisma.terminal.upsert({
        where: { terminal_id: terminalId },
        update: { secret_key: secretKey },
        create: {
          terminal_id: terminalId,
          status: "OFFLINE",
          secret_key: secretKey,
        },
      });

      await invalidateTerminalSecretCache(terminalId);
      logger.info({ terminalId }, "admin.terminal_secret_cache_invalidated");

      logger.info({ terminalId }, "admin.terminal_registered");
      res.json({ success: true, terminal });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.terminal_registration_error");
      res.status(500).json({ error: "Failed to register terminal" });
    }
  }
);

router.post(
  "/kyc/approve",
  async (req: Request<object, object, { userId: string }>, res: Response) => {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    try {
      const kyc = await approveKyc(userId);
      logger.info({ userId }, "admin.kyc_approved");
      res.json({ success: true, kyc });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.kyc_approve_error");
      res.status(500).json({ error: "Failed to approve KYC" });
    }
  }
);

router.post(
  "/kyc/reject",
  async (
    req: Request<object, object, { userId: string; reason: string }>,
    res: Response
  ) => {
    const { userId, reason } = req.body;

    if (!userId || !reason) {
      return res.status(400).json({ error: "userId and reason are required" });
    }

    try {
      const kyc = await rejectKyc(userId, reason);
      logger.info({ userId, reason }, "admin.kyc_rejected");
      res.json({ success: true, kyc });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.kyc_reject_error");
      res.status(500).json({ error: "Failed to reject KYC" });
    }
  }
);

export default router;

// ═════════════════════════════════════════════
// JWT-PROTECTED ADMIN ROUTER — AGENT MANAGEMENT
//
// Separate router from the secret-based one above.
// requireAdminSecret does NOT apply here — these
// routes are protected by JWT + requireAdmin instead.
// Mounted at the same /admin prefix via admin.routes.ts.
// ═════════════════════════════════════════════

// Valid AgentStatus values — used to guard the update-status route
const VALID_AGENT_STATUSES: AgentStatus[] = [
  "ACTIVE",
  "SUSPENDED",
  "DEACTIVATED",
];

// Safely extracts a single string from a query parameter.
// Express types req.query values as string | string[] | ParsedQs | ParsedQs[]
// — takes the first element when an array is given (duplicate query key),
// and returns undefined for nested ParsedQs objects we never expect here.
function qs(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return undefined;
}

const agentManagementRouter = express.Router();

// All routes in this router require a valid admin JWT
agentManagementRouter.use(authenticateToken, requireAdmin);

// ─────────────────────────────────────────────
// POST /admin/agents
// Create a new agent account.
// Body: { firstname, lastname, email, phone, password }
// ─────────────────────────────────────────────
agentManagementRouter.post(
  "/agents",
  async (
    req: CustomAuthRequest & {
      body: {
        firstname: string;
        lastname: string;
        email: string;
        phone: string;
        password: string;
      };
    },
    res: Response
  ) => {
    const { firstname, lastname, email, phone, password } = req.body;

    if (!firstname || !lastname || !email || !phone || !password) {
      return res.status(400).json({
        error: "firstname, lastname, email, phone, and password are required",
      });
    }

    try {
      // req.user is guaranteed by requireAdmin — safe to assert
      const adminId = req.user!.userId;
      const agent = await createAgent(
        { firstname, lastname, email, phone, password },
        adminId
      );

      logger.info({ agentId: agent.id, adminId }, "admin.route_agent_created");
      return res.status(201).json({ success: true, agent });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "EMAIL_ALREADY_IN_USE") {
          return res
            .status(409)
            .json({ error: "An agent with this email already exists" });
        }
      }

      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.route_create_agent_error");
      return res.status(500).json({ error: "Failed to create agent" });
    }
  }
);

// ─────────────────────────────────────────────
// GET /admin/agents
// Paginated agent list with optional status filter.
// Query: ?status=ACTIVE&page=1&limit=20
// ─────────────────────────────────────────────
agentManagementRouter.get(
  "/agents",
  async (req: CustomAuthRequest, res: Response) => {
    const rawStatus = qs(req.query.status);
    const page = Math.max(1, parseInt(qs(req.query.page) ?? "1") || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(qs(req.query.limit) ?? "20") || 20)
    );

    if (rawStatus && !VALID_AGENT_STATUSES.includes(rawStatus as AgentStatus)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_AGENT_STATUSES.join(
          ", "
        )}`,
      });
    }

    try {
      const result = await listAgents({
        status: rawStatus as AgentStatus | undefined,
        page,
        limit,
      });

      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.route_list_agents_error");
      return res.status(500).json({ error: "Failed to fetch agents" });
    }
  }
);

// ─────────────────────────────────────────────
// GET /admin/agents/:id
// Single agent detail — includes resolvedDisputeCount.
// ─────────────────────────────────────────────
agentManagementRouter.get(
  "/agents/:id",
  async (
    req: CustomAuthRequest & { params: { id: string } },
    res: Response
  ) => {
    const { id } = req.params;

    try {
      const agent = await getAgentById(id);
      return res.status(200).json({ success: true, agent });
    } catch (error) {
      if (error instanceof Error && error.message === "AGENT_NOT_FOUND") {
        return res.status(404).json({ error: "Agent not found" });
      }

      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: errMessage, agentId: id },
        "admin.route_get_agent_error"
      );
      return res.status(500).json({ error: "Failed to fetch agent" });
    }
  }
);

// ─────────────────────────────────────────────
// PATCH /admin/agents/:id/status
// Update agent account status.
// Body: { status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED" }
// Redis cache is invalidated inside the service — no TTL wait.
// ─────────────────────────────────────────────
agentManagementRouter.patch(
  "/agents/:id/status",
  async (
    req: CustomAuthRequest & {
      params: { id: string };
      body: { status: string };
    },
    res: Response
  ) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    if (!VALID_AGENT_STATUSES.includes(status as AgentStatus)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_AGENT_STATUSES.join(
          ", "
        )}`,
      });
    }

    try {
      const agent = await updateAgentStatus(id, status as AgentStatus);

      logger.info(
        { agentId: id, newStatus: status, adminId: req.user!.userId },
        "admin.route_agent_status_updated"
      );
      return res.status(200).json({ success: true, agent });
    } catch (error) {
      if (error instanceof Error) {
        switch (error.message) {
          case "AGENT_NOT_FOUND":
            return res.status(404).json({ error: "Agent not found" });
          case "AGENT_ALREADY_IN_STATUS":
            return res
              .status(409)
              .json({ error: "Agent is already in that status" });
          case "CANNOT_TRANSITION_FROM_DEACTIVATED":
            return res.status(409).json({
              error:
                "A deactivated agent can only be set to ACTIVE, not SUSPENDED",
            });
        }
      }

      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: errMessage, agentId: id },
        "admin.route_update_agent_status_error"
      );
      return res.status(500).json({ error: "Failed to update agent status" });
    }
  }
);

// ─────────────────────────────────────────────
// OVERVIEW + INCOME STATS
// ─────────────────────────────────────────────

// GET /admin/overview
agentManagementRouter.get(
  "/overview",
  async (_req: CustomAuthRequest, res: Response) => {
    try {
      const overview = await getAdminOverview();
      return res.status(200).json({ success: true, overview });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.route_overview_error");
      return res.status(500).json({ error: "Failed to fetch overview" });
    }
  }
);

// GET /admin/income
// Query: ?from=2025-01-01&to=2025-12-31&terminalId=term_01&driverUid=2022/1/12345LH
agentManagementRouter.get(
  "/income",
  async (req: CustomAuthRequest, res: Response) => {
    const rawFrom = qs(req.query.from);
    const rawTo = qs(req.query.to);
    const terminalId = qs(req.query.terminalId);
    const driverUid = qs(req.query.driverUid);

    // Parse date strings — invalid dates are silently dropped (treated as unfiltered)
    const from = rawFrom ? new Date(rawFrom) : undefined;
    const to = rawTo ? new Date(rawTo) : undefined;

    if (from && isNaN(from.getTime())) {
      return res.status(400).json({ error: "Invalid 'from' date format" });
    }
    if (to && isNaN(to.getTime())) {
      return res.status(400).json({ error: "Invalid 'to' date format" });
    }

    try {
      const stats = await getIncomeStats({ from, to, terminalId, driverUid });
      return res.status(200).json({ success: true, stats });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.route_income_error");
      return res.status(500).json({ error: "Failed to fetch income stats" });
    }
  }
);

// GET /admin/terminals
// Shared with agents — mounted here for admin JWT access too
agentManagementRouter.get(
  "/terminals",
  async (_req: CustomAuthRequest, res: Response) => {
    try {
      const terminals = await listTerminals();
      return res.status(200).json({ success: true, terminals });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.route_terminals_error");
      return res.status(500).json({ error: "Failed to fetch terminals" });
    }
  }
);

// ─────────────────────────────────────────────
// DISPUTE MANAGEMENT
// ─────────────────────────────────────────────

const VALID_DISPUTE_STATUSES = [
  "OPEN",
  "UNDER_REVIEW",
  "RESOLVED",
  "REJECTED",
] as const;
type ValidDisputeStatus = (typeof VALID_DISPUTE_STATUSES)[number];

// GET /admin/disputes
// Query: ?status=OPEN&page=1&limit=20
agentManagementRouter.get(
  "/disputes",
  async (req: CustomAuthRequest, res: Response) => {
    const rawStatus = qs(req.query.status);
    const page = Math.max(1, parseInt(qs(req.query.page) ?? "1") || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(qs(req.query.limit) ?? "20") || 20)
    );

    if (
      rawStatus &&
      !VALID_DISPUTE_STATUSES.includes(rawStatus as ValidDisputeStatus)
    ) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_DISPUTE_STATUSES.join(
          ", "
        )}`,
      });
    }

    try {
      const result = await listDisputes({
        status: rawStatus as ValidDisputeStatus | undefined,
        page,
        limit,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.route_list_disputes_error");
      return res.status(500).json({ error: "Failed to fetch disputes" });
    }
  }
);

// GET /admin/disputes/:id
agentManagementRouter.get(
  "/disputes/:id",
  async (
    req: CustomAuthRequest & { params: { id: string } },
    res: Response
  ) => {
    const { id } = req.params;
    try {
      const dispute = await getDisputeById(id);
      return res.status(200).json({ success: true, dispute });
    } catch (error) {
      if (error instanceof Error && error.message === "DISPUTE_NOT_FOUND") {
        return res.status(404).json({ error: "Dispute not found" });
      }
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: errMessage, disputeId: id },
        "admin.route_get_dispute_error"
      );
      return res.status(500).json({ error: "Failed to fetch dispute" });
    }
  }
);

// PATCH /admin/disputes/:id/status
// Body: { status: "UNDER_REVIEW" | "RESOLVED" | "REJECTED", resolution?: string }
agentManagementRouter.patch(
  "/disputes/:id/status",
  async (
    req: CustomAuthRequest & {
      params: { id: string };
      body: { status: string; resolution?: string };
    },
    res: Response
  ) => {
    const { id } = req.params;
    const { status, resolution } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    if (!VALID_DISPUTE_STATUSES.includes(status as ValidDisputeStatus)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_DISPUTE_STATUSES.join(
          ", "
        )}`,
      });
    }

    try {
      const dispute = await updateDisputeStatus(id, {
        newStatus: status as ValidDisputeStatus,
        resolution,
        adminId: req.user!.userId,
      });

      logger.info(
        { disputeId: id, newStatus: status, adminId: req.user!.userId },
        "admin.route_dispute_status_updated"
      );
      return res.status(200).json({ success: true, dispute });
    } catch (error) {
      if (error instanceof Error) {
        switch (error.message) {
          case "DISPUTE_NOT_FOUND":
            return res.status(404).json({ error: "Dispute not found" });
          case "DISPUTE_ALREADY_CLOSED":
            return res
              .status(409)
              .json({ error: "Dispute is already resolved or rejected" });
          case "RESOLUTION_REQUIRED":
            return res
              .status(400)
              .json({
                error: "resolution text is required when closing a dispute",
              });
        }
      }
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: errMessage, disputeId: id },
        "admin.route_update_dispute_error"
      );
      return res.status(500).json({ error: "Failed to update dispute" });
    }
  }
);
// ─────────────────────────────────────────────
// POST /admin/notifications
// Admin sends a notification to a specific student.
// Body: { studentMatric, title, body }
// ─────────────────────────────────────────────
agentManagementRouter.post(
  "/notifications",
  async (
    req: CustomAuthRequest & {
      body: { studentMatric: string; title: string; body: string };
    },
    res: Response
  ) => {
    const { studentMatric, title, body } = req.body;

    if (!studentMatric || !title || !body) {
      return res
        .status(400)
        .json({ error: "studentMatric, title, and body are required" });
    }

    try {
      const notification = await sendNotification(studentMatric, title, body);
      logger.info(
        { studentMatric, adminId: req.user!.userId },
        "admin.route_notification_sent"
      );
      return res.status(201).json({ success: true, notification });
    } catch (error) {
      if (error instanceof Error && error.message === "STUDENT_NOT_FOUND") {
        return res.status(404).json({ error: "Student not found" });
      }
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.route_send_notification_error");
      return res.status(500).json({ error: "Failed to send notification" });
    }
  }
);

// admin.controller.ts — add inside the secret-protected router

router.post(
  "/sync/whitelist",
  async (req: Request, res: Response) => {
    const log = logger.child({});

    try {
      const cardMappings = await prisma.cardMapping.findMany({
        select: { card_uid: true },
      });

      const terminals = await prisma.terminal.findMany({
        select: { terminal_id: true },
      });

      const whitelistUids = cardMappings.map(
        (c: { card_uid: string }) => c.card_uid
      );

      const MAX_CHUNK_BYTES = 500;
      const SLEEP_MS = 2000;
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      // Build WL chunks using same logic as MQTT service
      const buildChunks = (
        prefix: string,
        uids: string[],
        maxBytes: number
      ): string[] => {
        const chunks: string[] = [];
        let currentChunk: string[] = [];
        let currentSize = prefix.length;

        for (const uid of uids) {
          const segment =
            currentChunk.length === 0 ? uid : `|${uid}`;
          if (currentSize + segment.length > maxBytes) {
            chunks.push(`${prefix}${currentChunk.join("|")}`);
            currentChunk = [uid];
            currentSize = prefix.length + uid.length;
          } else {
            currentChunk.push(uid);
            currentSize += segment.length;
          }
        }

        if (currentChunk.length > 0) {
          chunks.push(`${prefix}${currentChunk.join("|")}`);
        }

        return chunks;
      };

      const wlChunks =
        whitelistUids.length === 0
          ? ["SYS:WL,EMPTY"]
          : buildChunks("SYS:WL,", whitelistUids, MAX_CHUNK_BYTES);

      log.info(
        {
          terminalCount: terminals.length,
          cardCount: whitelistUids.length,
          chunkCount: wlChunks.length,
        },
        "admin.sync_whitelist_started"
      );

      // Respond immediately — don't make the client wait for all chunks
      res.json({
        success: true,
        message: `Whitelist sync queued for ${terminals.length} terminal(s). ${whitelistUids.length} card(s), ${wlChunks.length} chunk(s).`,
      });

      // Queue chunks to each terminal after responding
      for (const terminal of terminals) {
        const terminalId = terminal.terminal_id;

        for (let i = 0; i < wlChunks.length; i++) {
          await enqueueRoute(terminalId, wlChunks[i]);
          if (i < wlChunks.length - 1) await sleep(SLEEP_MS);
        }

        await sleep(SLEEP_MS);
        await enqueueRoute(terminalId, "SYS:SYNC_COMPLETE");

        log.info({ terminalId }, "admin.sync_whitelist_queued");
      }
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: errMessage }, "admin.sync_whitelist_error");
      // Response already sent — just log
    }
  }
);

export { agentManagementRouter };
