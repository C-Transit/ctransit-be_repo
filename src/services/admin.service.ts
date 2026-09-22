import bcrypt from "bcryptjs";
import { type AgentStatus, type DisputeStatus } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { getRedisClient, cacheKeys } from "../config/redis.js";
import logger from "../config/logger.js";
import { sendNotification } from "./notification.service.js";

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
  resolvedDisputeCount: number;
}

export interface ListAgentsResult {
  agents: AgentSummary[];
  total: number;
  page: number;
  totalPages: number;
}

async function createAgent(
  data: CreateAgentInput,
  adminId: string
): Promise<AgentSummary> {
  const normalisedEmail = data.email.toLowerCase().trim();

  // Explicit uniqueness check before hashing — gives a clean error
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

async function updateAgentStatus(
  agentId: string,
  newStatus: AgentStatus,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaClient: any = prisma,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisClient: any = getRedisClient()
): Promise<AgentSummary> {
  // Confirm the agent exists before updating
  const existing = await prismaClient.agent.findUnique({
    where: { id: agentId },
    select: { id: true, status: true },
  });

  if (!existing) {
    throw new Error("AGENT_NOT_FOUND");
  }

  if (existing.status === newStatus) {
    throw new Error("AGENT_ALREADY_IN_STATUS");
  }

  if (existing.status === "DEACTIVATED" && newStatus !== "ACTIVE") {
    throw new Error("CANNOT_TRANSITION_FROM_DEACTIVATED");
  }

  const updated = await prismaClient.agent.update({
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

  
  try {
    const redis = redisClient;
    await redis.del(cacheKeys.agentStatus(agentId));
  } catch (redisErr) {
    const errMessage =
      redisErr instanceof Error ? redisErr.message : String(redisErr);
    logger.warn(
      { err: errMessage, agentId },
      "admin.agent_status_redis_invalidation_failed"
    );
  }

  logger.info(
    { agentId, previousStatus: existing.status, newStatus },
    "admin.agent_status_updated"
  );

  return updated;
}

async function listAgents(
  filters: ListAgentsFilter
): Promise<ListAgentsResult> {
  const { status, page, limit } = filters;
  const skip = (page - 1) * limit;

 
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

async function listTerminals() {
  return prisma.terminal.findMany({
    orderBy: { terminal_id: "asc" },
    select: {
      terminal_id: true,
      status: true,
      active_driver_uid: true,
      location: true,
    },
  });
}

async function updateTerminalLocation(terminalId: string, location: string) {
  return prisma.terminal.update({
    where: { terminal_id: terminalId },
    data: { location },
  });
}

export { listTerminals, updateTerminalLocation };

async function getAdminOverview() {
  const cacheKey = "admin:overview:cache";
  const redis = getRedisClient();

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.debug({ err: String(err) }, "admin.overview_cache_read_error");
  }

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

  const overview = {
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

  try {
    await redis.setex(cacheKey, 30, JSON.stringify(overview));
  } catch (err) {
    logger.debug({ err: String(err) }, "admin.overview_cache_write_error");
  }

  return overview;
}

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

  // Add student_uid to the existing select
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

  // Notify student of dispute status change 
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

export { sendNotification } from "../services/notification.service.js";
