import type { Request, Response, NextFunction } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import logger from "../config/logger.js";
import env from "../config/env.js";
import prisma from "../lib/prisma.js";
import { getRedisClient, cacheKeys, AGENT_STATUS_TTL } from "../config/redis.js";

// payload interface
export interface UserJwtPayload extends JwtPayload {
  userId: string;
  role: "ADMIN" | "AGENT" | "STUDENT" | "DRIVER";
  email: string;
}

// Augmented Express Request
export interface CustomAuthRequest extends Request {
  user?: UserJwtPayload;
}

// authenticateToken middleware
function authenticateToken(
  req: CustomAuthRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    logger.warn({ ip: req.ip, path: req.path }, "auth.no_token_provided");
    res.status(401).json({ error: "Access token required" });
    return;
  }

  try {
    const decoded = jwt.verify(token, env.jwt.secret) as UserJwtPayload;
    req.user = decoded;
    next();
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.warn(
      { ip: req.ip, err: errMessage },
      "auth.token_verification_failed"
    );
    res.status(403).json({ error: "Invalid or expired token" });
  }
}

// requireAdmin middleware
function requireAdmin(
  req: CustomAuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== "ADMIN") {
    logger.warn(
      { userId: req.user?.userId, role: req.user?.role, path: req.path },
      "auth.admin_required"
    );
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

// requireAgent
function requireAgent(
  req: CustomAuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== "AGENT") {
    logger.warn(
      { userId: req.user?.userId, role: req.user?.role, path: req.path },
      "auth.agent_required"
    );
    res.status(403).json({ error: "Agent access required" });
    return;
  }
  next();
}

// requireAdminOrAgent
function requireAdminOrAgent(
  req: CustomAuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || (req.user.role !== "ADMIN" && req.user.role !== "AGENT")) {
    logger.warn(
      { userId: req.user?.userId, role: req.user?.role, path: req.path },
      "auth.admin_or_agent_required"
    );
    res.status(403).json({ error: "Admin or Agent access required" });
    return;
  }
  next();
}

// requireStudent
function requireStudent(
  req: CustomAuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== "STUDENT") {
    logger.warn(
      { userId: req.user?.userId, role: req.user?.role, path: req.path },
      "auth.student_required"
    );
    res.status(403).json({ error: "Student access required" });
    return;
  }
  next();
}

// requireDriver
function requireDriver(
  req: CustomAuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== "DRIVER") {
    logger.warn(
      { userId: req.user?.userId, role: req.user?.role, path: req.path },
      "auth.driver_required"
    );
    res.status(403).json({ error: "Driver access required" });
    return;
  }
  next();
}

// checkAgentActive
async function checkAgentActive(
  req: CustomAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user || req.user.role !== "AGENT") {
    next();
    return;
  }

  const agentId = req.user.userId;

  try {
    const redis = getRedisClient();
    const cacheKey = cacheKeys.agentStatus(agentId);
    let status: string | null = null;

    try {
      status = await redis.get(cacheKey);
    } catch {
      // Redis offline/failure fallback to DB
    }

    if (!status) {
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        select: { status: true },
      });

      if (!agent) {
        logger.warn({ agentId }, "auth.agent_not_found_in_db");
        res.status(403).json({ error: "Agent account not found" });
        return;
      }

      status = agent.status;
      try {
        await redis.setex(cacheKey, AGENT_STATUS_TTL, status);
      } catch {
        // ignore redis write error
      }
    }

    if (status !== "ACTIVE") {
      logger.warn(
        { agentId, status },
        "auth.agent_blocked_by_status"
      );
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
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ agentId, err: errMessage }, "auth.check_agent_active_error");
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
