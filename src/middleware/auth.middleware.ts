// src/middleware/auth.middleware.ts
import type { Request, Response, NextFunction } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import logger from "../config/logger.js";
import env from "../config/env.js";
import prisma from "../lib/prisma.js";
import { getRedisClient, cacheKeys, AGENT_STATUS_TTL } from "../config/redis.js";

type Role = "ADMIN" | "AGENT" | "STUDENT" | "DRIVER";

export interface UserJwtPayload extends JwtPayload {
  userId: string;
  role: Role;
  email: string;
}

export interface CustomAuthRequest extends Request {
  user?: UserJwtPayload;
}

function authenticateToken(req: CustomAuthRequest, res: Response, next: NextFunction): void {
  const token = req.headers["authorization"]?.split(" ")[1];

  if (!token) {
    logger.warn({ ip: req.ip, path: req.path }, "auth.no_token_provided");
    res.status(401).json({ error: "Access token required" });
    return;
  }

  try {
    req.user = jwt.verify(token, env.jwt.secret, { algorithms: ["HS256"] }) as UserJwtPayload;
    next();
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    // Expired is routine with short-lived tokens: 401 tells clients to call /auth/refresh.
    (expired ? logger.debug : logger.warn).call(
      logger,
      { ip: req.ip, err: error instanceof Error ? error.message : "Unknown error" },
      "auth.token_verification_failed"
    );
    res
      .status(expired ? 401 : 403)
      .json({ error: expired ? "Token expired" : "Invalid or expired token", code: expired ? "TOKEN_EXPIRED" : "INVALID_TOKEN" });
  }
}

const requireRole =
  (event: string, message: string, ...roles: Role[]) =>
    (req: CustomAuthRequest, res: Response, next: NextFunction): void => {
      if (!req.user || !roles.includes(req.user.role)) {
        logger.warn({ userId: req.user?.userId, role: req.user?.role, path: req.path }, event);
        res.status(403).json({ error: message });
        return;
      }
      next();
    };

const requireAdmin = requireRole("auth.admin_required", "Admin access required", "ADMIN");
const requireAgent = requireRole("auth.agent_required", "Agent access required", "AGENT");
const requireAdminOrAgent = requireRole("auth.admin_or_agent_required", "Admin or Agent access required", "ADMIN", "AGENT");
const requireStudent = requireRole("auth.student_required", "Student access required", "STUDENT");
const requireDriver = requireRole("auth.driver_required", "Driver access required", "DRIVER");

// Blocks suspended/deactivated agents. Status is cached in Redis for AGENT_STATUS_TTL seconds.
async function checkAgentActive(req: CustomAuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.user?.role !== "AGENT") {
    next();
    return;
  }

  const agentId = req.user.userId;

  try {
    const redis = getRedisClient();
    const cacheKey = cacheKeys.agentStatus(agentId);
    let status = await redis.get(cacheKey).catch(() => null);

    if (!status) {
      const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
      if (!agent) {
        logger.warn({ agentId }, "auth.agent_not_found_in_db");
        res.status(403).json({ error: "Agent account not found" });
        return;
      }
      status = agent.status;
      redis.setex(cacheKey, AGENT_STATUS_TTL, status).catch(() => { });
    }

    if (status !== "ACTIVE") {
      logger.warn({ agentId, status }, "auth.agent_blocked_by_status");
      res.status(403).json({
        error:
          status === "SUSPENDED"
            ? "Agent account is temporarily suspended"
            : "Agent account has been deactivated",
      });
      return;
    }

    next();
  } catch (error) {
    logger.error(
      { agentId, err: error instanceof Error ? error.message : "Unknown error" },
      "auth.check_agent_active_error"
    );
    res.status(500).json({ error: "Unable to verify agent status" });
  }
}

export {
  authenticateToken,
  requireAdmin,
  requireAgent,
  requireAdminOrAgent,
  requireStudent,
  requireDriver,
  checkAgentActive,
};