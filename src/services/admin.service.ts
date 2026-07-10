import bcrypt from "bcryptjs";
import { type AgentStatus, type DisputeStatus } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { getRedisClient, cacheKeys } from "../config/redis.js";
import logger from "../config/logger.js";
import { sendNotification } from "./notification.service.js";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface CreateAgentInput {
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  password: string;
}

export interface ListAgentsFilter {
  status?: AgentStatus;
  page: number;
  limit: number;
}

// Shared shape for list items and single-agent detail
export interface AgentSummary {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  status: AgentStatus;
  createdAt: Date;
  createdBy: string;
}

export interface AgentDetail extends AgentSummary {
  updatedAt: Date;
  // Counts derived from related tables — useful for the admin detail view
  // without exposing the full relation arrays
  resolvedDisputeCount: number;
}

export interface ListAgentsResult {
  agents: AgentSummary[];
  total: number;
  page: number;
  totalPages: number;
}

// ─────────────────────────────────────────────
// createAgent
//
// Called by admin to register a new agent.
// The agent's initial password is set by the admin
// and communicated out-of-band — no OTP flow needed
// since agents are internal staff, not self-registering.
// ─────────────────────────────────────────────
async function createAgent(
  data: CreateAgentInput,
  adminId: string
): Promise<AgentSummary> {
  const normalisedEmail = data.email.toLowerCase().trim();

  // Explicit uniqueness check before hashing — gives a clean error
  // rather than letting Prisma throw a P2002 unique constraint violation
  const existing = await prisma.agent.findUnique({
    where: { email: normalisedEmail },
    select: { id: true },
  });

  if (existing) {
    throw new Error("EMAIL_ALREADY_IN_USE");
  }

  // Salt rounds match the rest of the codebase (10)
  const passwordHash = await bcrypt.hash(data.password, 10);

  const agent = await prisma.agent.create({
    data: {
      firstname: data.firstname.trim(),
      lastname: data.lastname.trim(),
      email: normalisedEmail,
      phone: data.phone.trim(),
      password: passwordHash,
      createdBy: adminId,
      // status defaults to ACTIVE via schema default
    },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      createdBy: true,
    },
  });

  logger.info({ agentId: agent.id, createdBy: adminId }, "admin.agent_created");

  return agent;
}

// ─────────────────────────────────────────────
// updateAgentStatus
//
// Handles SUSPEND, DEACTIVATE, and REACTIVATE.
// Redis cache key is DEL'd immediately on every
// status change — not waiting for TTL expiry —
// so the next request re-fetches the real status
// from DB within milliseconds of the admin action.
// ─────────────────────────────────────────────
async function updateAgentStatus(
  agentId: string,
  newStatus: AgentStatus
): Promise<AgentSummary> {
  // Confirm the agent exists before updating
  const existing = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, status: true },
  });

  if (!existing) {
    throw new Error("AGENT_NOT_FOUND");
  }

  // Guard against no-op updates — DEACTIVATED is terminal in the current
  // business logic; admin must create a new agent account instead
  if (existing.status === newStatus) {
    throw new Error("AGENT_ALREADY_IN_STATUS");
  }

  if (existing.status === "DEACTIVATED" && newStatus !== "ACTIVE") {
    // A DEACTIVATED agent can only be explicitly reactivated by setting ACTIVE —
    // going straight from DEACTIVATED to SUSPENDED makes no operational sense
    throw new Error("CANNOT_TRANSITION_FROM_DEACTIVATED");
  }

  const updated = await prisma.agent.update({
    where: { id: agentId },
    data: { status: newStatus },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      createdBy: true,
    },
  });

  // Invalidate Redis cache immediately so checkAgentActive middleware
  // picks up the new status on the agent's very next request
  const redis = getRedisClient();
  await redis.del(cacheKeys.agentStatus(agentId));

  logger.info(
    { agentId, previousStatus: existing.status, newStatus },
    "admin.agent_status_updated"
  );

  return updated;
}

// ─────────────────────────────────────────────
// listAgents
//
// Paginated agent list with optional status filter.
// Returns total for the frontend to compute pages.
// ─────────────────────────────────────────────
async function listAgents(
  filters: ListAgentsFilter
): Promise<ListAgentsResult> {
  const { status, page, limit } = filters;
  const skip = (page - 1) * limit;

  // Build where clause — omit status key entirely when not filtering
  // so Prisma doesn't add a redundant WHERE clause
  const where = status ? { status } : {};

  const [agents, total] = await prisma.$transaction([
    prisma.agent.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
        status: true,
        createdAt: true,
        createdBy: true,
      },
    }),
    prisma.agent.count({ where }),
  ]);

  return {
    agents,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

// ─────────────────────────────────────────────
// getAgentById
//
// Single agent detail view for the admin panel.
// Includes resolvedDisputeCount for the sidebar
// stat — avoids returning the full Dispute array.
// ─────────────────────────────────────────────
async function getAgentById(agentId: string): Promise<AgentDetail> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      createdBy: true,
      _count: {
        select: {
          // Counts disputes this agent has resolved — a proxy for activity
          resolvedDisputes: true,
        },
      },
    },
  });

  if (!agent) {
    throw new Error("AGENT_NOT_FOUND");
  }

  const { _count, ...agentData } = agent;

  return {
    ...agentData,
    resolvedDisputeCount: _count.resolvedDisputes,
  };
}

export { createAgent, updateAgentStatus, listAgents, getAgentById };

// ─────────────────────────────────────────────
// listTerminals
// Shared between agent and admin — returns all
// terminals with status and active driver.
// secret_key is deliberately excluded; it must
// never leave the server via API response.
// ─────────────────────────────────────────────
async function listTerminals() {
  return prisma.terminal.findMany({
    orderBy: { terminal_id: "asc" },
    select: {
      terminal_id: true,
      status: true,
      active_driver_uid: true,
      // secret_key intentionally omitted
    },
  });
}

export { listTerminals };

// ═════════════════════════════════════════════
// OVERVIEW + INCOME STATS + DISPUTE MANAGEMENT
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// getAdminOverview
//
// Single endpoint that powers the admin dashboard
// home screen. Uses Promise.all (not $transaction)
// because these are independent read-only queries
// and a consistent snapshot isn't required for a
// dashboard — speed matters more here.
//
// Decimal amounts from Prisma are converted to
// plain numbers via parseFloat(toString()) — the
// schema uses Decimal(10,2) so precision is safe.
// ─────────────────────────────────────────────
async function getAdminOverview() {
  const now = new Date();
  // Date boundaries for income time buckets
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const toDecimal = (val: { _sum: { amount: unknown } }) =>
    val._sum.amount ? parseFloat(val._sum.amount.toString()) : 0;

  const [
    totalStudents,
    totalActiveAgents,
    totalDrivers,
    openDisputes,
    underReviewDisputes,
    allTimeFare,
    todayFare,
    weekFare,
    monthFare,
    totalTopUps,
    totalWalletBalance,
    topTerminals,
    topDrivers,
  ] = await Promise.all([
    // Headcounts
    prisma.user.count({ where: { role: "STUDENT" } }),
    prisma.agent.count({ where: { status: "ACTIVE" } }),
    prisma.user.count({ where: { role: "DRIVER" } }),
    prisma.dispute.count({ where: { status: "OPEN" } }),
    prisma.dispute.count({ where: { status: "UNDER_REVIEW" } }),

    // All-time fare revenue (RIDE transactions only)
    prisma.transaction.aggregate({
      where: { type: "RIDE" },
      _sum: { amount: true },
    }),

    // Today's fare
    prisma.transaction.aggregate({
      where: { type: "RIDE", synced_at: { gte: startOfToday } },
      _sum: { amount: true },
    }),

    // Last 7 days
    prisma.transaction.aggregate({
      where: { type: "RIDE", synced_at: { gte: startOfWeek } },
      _sum: { amount: true },
    }),

    // This calendar month
    prisma.transaction.aggregate({
      where: { type: "RIDE", synced_at: { gte: startOfMonth } },
      _sum: { amount: true },
    }),

    // Total Monnify top-ups processed
    prisma.transaction.aggregate({
      where: { type: "TOPUP" },
      _sum: { amount: true },
    }),

    // Sum of all wallet balances — total float in the system
    prisma.wallet.aggregate({
      _sum: { balance: true },
    }),

    // Top 5 terminals by all-time revenue
    prisma.transaction.groupBy({
      by: ["terminal_id"],
      where: { type: "RIDE" },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
      take: 5,
    }),

    // Top 5 drivers by all-time revenue
    prisma.transaction.groupBy({
      by: ["driver_uid"],
      where: { type: "RIDE", driver_uid: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
      take: 5,
    }),
  ]);

  return {
    counts: {
      students: totalStudents,
      activeAgents: totalActiveAgents,
      drivers: totalDrivers,
      openDisputes,
      underReviewDisputes,
    },
    wallets: {
      // Float in system — sum of all student wallet balances
      totalBalance: totalWalletBalance._sum.balance
        ? parseFloat(totalWalletBalance._sum.balance.toString())
        : 0,
      totalTopUps: toDecimal(totalTopUps),
    },
    income: {
      allTime: toDecimal(allTimeFare),
      today: toDecimal(todayFare),
      thisWeek: toDecimal(weekFare),
      thisMonth: toDecimal(monthFare),
    },
    topTerminals: topTerminals.map((t) => ({
      terminal_id: t.terminal_id,
      revenue: t._sum.amount ? parseFloat(t._sum.amount.toString()) : 0,
    })),
    topDrivers: topDrivers.map((d) => ({
      driver_uid: d.driver_uid,
      revenue: d._sum.amount ? parseFloat(d._sum.amount.toString()) : 0,
    })),
  };
}

// ─────────────────────────────────────────────
// getIncomeStats
//
// Filterable income report for the admin income
// view. Supports arbitrary date ranges, terminal
// filter, and driver filter — any combination.
// Returns the aggregate total + a breakdown by
// terminal and by driver within the filter window.
// ─────────────────────────────────────────────
export interface IncomeStatsFilter {
  from?: Date;
  to?: Date;
  terminalId?: string;
  driverUid?: string;
}

async function getIncomeStats(filters: IncomeStatsFilter) {
  const { from, to, terminalId, driverUid } = filters;

  const where = {
    type: "RIDE" as const,
    ...(from || to
      ? {
          synced_at: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
    ...(terminalId && { terminal_id: terminalId }),
    ...(driverUid && { driver_uid: driverUid }),
  };

  const [total, byTerminal, byDriver] = await Promise.all([
    prisma.transaction.aggregate({
      where,
      _sum: { amount: true },
      _count: { transaction_id: true },
    }),

    // Per-terminal breakdown — skip if already filtering by one terminal
    terminalId
      ? Promise.resolve([])
      : prisma.transaction.groupBy({
          by: ["terminal_id"],
          where,
          _sum: { amount: true },
          _count: { transaction_id: true },
          orderBy: { _sum: { amount: "desc" } },
        }),

    // Per-driver breakdown — skip if already filtering by one driver
    driverUid
      ? Promise.resolve([])
      : prisma.transaction.groupBy({
          by: ["driver_uid"],
          where: { ...where, driver_uid: { not: null } },
          _sum: { amount: true },
          _count: { transaction_id: true },
          orderBy: { _sum: { amount: "desc" } },
        }),
  ]);

  return {
    filters: { from, to, terminalId, driverUid },
    total: {
      revenue: total._sum.amount ? parseFloat(total._sum.amount.toString()) : 0,
      transactions: total._count.transaction_id,
    },
    byTerminal: (byTerminal as typeof byTerminal).map((t) => ({
      terminal_id: t.terminal_id,
      revenue: t._sum.amount ? parseFloat(t._sum.amount.toString()) : 0,
      transactions: t._count.transaction_id,
    })),
    byDriver: (byDriver as typeof byDriver).map((d) => ({
      driver_uid: d.driver_uid,
      revenue: d._sum.amount ? parseFloat(d._sum.amount.toString()) : 0,
      transactions: d._count.transaction_id,
    })),
  };
}

// ─────────────────────────────────────────────
// listDisputes
// ─────────────────────────────────────────────

export interface ListDisputesFilter {
  status?: DisputeStatus;
  page: number;
  limit: number;
}

async function listDisputes(filters: ListDisputesFilter) {
  const { status, page, limit } = filters;
  const skip = (page - 1) * limit;
  const where = status ? { status } : {};

  const [disputes, total] = await prisma.$transaction([
    prisma.dispute.findMany({
      where,
      skip,
      take: limit,
      // Oldest open disputes first — work through queue in order
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        description: true,
        status: true,
        resolution: true,
        resolvedAt: true,
        createdAt: true,
        updatedAt: true,
        student_uid: true,
        transaction_id: true,
        resolvedByAdmin: true,
        resolvedByAgent: true,
      },
    }),
    prisma.dispute.count({ where }),
  ]);

  return {
    disputes,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

// ─────────────────────────────────────────────
// getDisputeById
//
// Full dispute detail including the disputed
// transaction and student info — everything the
// admin needs to make a resolution decision on
// one screen.
// ─────────────────────────────────────────────
async function getDisputeById(disputeId: string) {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    select: {
      id: true,
      description: true,
      status: true,
      resolution: true,
      resolvedAt: true,
      createdAt: true,
      updatedAt: true,
      student_uid: true,
      resolvedByAdmin: true,
      resolvedByAgent: true,
      // The disputed transaction — amount, type, terminal, driver
      transaction: {
        select: {
          transaction_id: true,
          type: true,
          amount: true,
          terminal_id: true,
          driver_uid: true,
          synced_at: true,
        },
      },
      // Basic student info for the dispute card
      user: {
        select: {
          firstname: true,
          lastname: true,
          email: true,
        },
      },
    },
  });

  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");
  return dispute;
}

// ─────────────────────────────────────────────
// updateDisputeStatus
//
// Handles all three admin dispute actions:
//   UNDER_REVIEW — admin has picked it up
//   RESOLVED     — closed with a resolution note (required)
//   REJECTED     — closed without credit (required note)
//
// Terminal states: RESOLVED and REJECTED cannot
// be transitioned further.
// resolvedByAdmin is only set on final states.
// ─────────────────────────────────────────────
export interface DisputeUpdateInput {
  newStatus: DisputeStatus;
  resolution?: string;
  adminId: string;
}

async function updateDisputeStatus(
  disputeId: string,
  input: DisputeUpdateInput
) {
  const { newStatus, resolution, adminId } = input;

  // ← Add student_uid to the existing select
  const existing = await prisma.dispute.findUnique({
    where: { id: disputeId },
    select: { id: true, status: true, student_uid: true },
  });

  if (!existing) throw new Error("DISPUTE_NOT_FOUND");

  if (existing.status === "RESOLVED" || existing.status === "REJECTED") {
    throw new Error("DISPUTE_ALREADY_CLOSED");
  }

  if (
    (newStatus === "RESOLVED" || newStatus === "REJECTED") &&
    !resolution?.trim()
  ) {
    throw new Error("RESOLUTION_REQUIRED");
  }

  const isFinalState = newStatus === "RESOLVED" || newStatus === "REJECTED";

  const updated = await prisma.dispute.update({
    where: { id: disputeId },
    data: {
      status: newStatus,
      ...(resolution && { resolution: resolution.trim() }),
      ...(isFinalState && {
        resolvedByAdmin: adminId,
        resolvedAt: new Date(),
      }),
    },
    select: {
      id: true,
      status: true,
      resolution: true,
      resolvedAt: true,
      resolvedByAdmin: true,
      updatedAt: true,
    },
  });

  // ── Notify student of dispute status change ───────────────────────
  const studentMatric = existing.student_uid;

  if (newStatus === "UNDER_REVIEW") {
    sendNotification(
      studentMatric,
      "Dispute Under Review 🔍",
      `Your dispute (ID: ${disputeId.slice(
        0,
        8
      )}...) has been picked up and is currently being reviewed by our team.`
    ).catch(() => {});
  } else if (newStatus === "RESOLVED") {
    sendNotification(
      studentMatric,
      "Dispute Resolved ✅",
      `Your dispute has been resolved. Resolution: ${resolution}. Thank you for your patience.`
    ).catch(() => {});
  } else if (newStatus === "REJECTED") {
    sendNotification(
      studentMatric,
      "Dispute Update ❌",
      `Your dispute could not be upheld. Reason: ${resolution}. Contact support if you have further concerns.`
    ).catch(() => {});
  }

  return updated;
}

export {
  getAdminOverview,
  getIncomeStats,
  listDisputes,
  getDisputeById,
  updateDisputeStatus,
};

// ─────────────────────────────────────────────
// sendNotification
// Re-exported from notification.service.ts so
// admin.controller.ts has a single service import
// path for all admin operations.
// ─────────────────────────────────────────────
export { sendNotification } from "../services/notification.service.js";
