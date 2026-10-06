// src/services/agent.service.ts
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { issueRefreshToken } from "./token.service.js";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

// Updated to include refreshToken alongside the access token
export interface AgentLoginResult {
  token: string;
  refreshToken: string; // ← added
  agent: {
    id: string;
    firstname: string;
    lastname: string;
    email: string;
    phone: string;
    status: string;
  };
}

// ─────────────────────────────────────────────
// loginAgent
//
// Verifies agent credentials and issues a signed JWT.
//
// Timing note: we always run bcrypt.compare even when
// the agent row is not found (dummy compare against a
// static hash). This prevents email enumeration via
// response-time differences — an attacker cannot tell
// whether the email exists or the password was wrong.
//
// Status errors (SUSPENDED / DEACTIVATED) are surfaced
// only after the password is confirmed correct, so a
// legitimate agent gets a clear reason they're blocked.
// ─────────────────────────────────────────────

// Pre-computed hash used in the dummy compare path.
// bcrypt.compare is constant-time regardless of match,
// but calling it at all is what prevents timing leaks.
const DUMMY_HASH =
  "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

async function loginAgent(
  email: string,
  password: string
): Promise<AgentLoginResult> {
  const normalisedEmail = email.toLowerCase().trim();

  const agent = await prisma.agent.findUnique({
    where: { email: normalisedEmail },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      phone: true,
      password: true,
      status: true,
    },
  });

  // Always run bcrypt — prevents timing-based email enumeration
  const passwordMatch = await bcrypt.compare(
    password,
    agent?.password ?? DUMMY_HASH
  );

  if (!agent || !passwordMatch) {
    logger.warn({ email: normalisedEmail }, "agent.login_invalid_credentials");
    throw new Error("INVALID_CREDENTIALS");
  }

  // Status check is after credential verification — the agent
  // deserves a clear reason for the block, not a generic error
  if (agent.status !== "ACTIVE") {
    logger.warn(
      { agentId: agent.id, status: agent.status },
      "agent.login_blocked_by_status"
    );
    throw new Error(
      agent.status === "SUSPENDED" ? "AGENT_SUSPENDED" : "AGENT_DEACTIVATED"
    );
  }

  const token = jwt.sign(
    { userId: agent.id, role: "AGENT", email: agent.email },
    env.jwt.secret,
    { expiresIn: "8h" }
  );

  // Issue refresh token — stored in Redis under refresh:{tokenId}
  // with 7-day TTL. Revoked on logout via DELETE /api/auth/logout.
  const refreshToken = await issueRefreshToken({
    userId: agent.id,
    role: "AGENT",
    email: agent.email,
  });

  logger.info({ agentId: agent.id }, "agent.login_success");

  return {
    token,
    refreshToken, // ← added
    agent: {
      id: agent.id,
      firstname: agent.firstname,
      lastname: agent.lastname,
      email: agent.email,
      phone: agent.phone,
      status: agent.status,
    },
  };
}

export { loginAgent };
