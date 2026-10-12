import bcrypt from "bcryptjs";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import { issueRefreshToken, signAccessToken } from "./token.service.js";
import { isLocked, recordFailure, clearFailures } from "./lockout.service.js";

export interface AgentLoginResult {
  token: string;
  refreshToken: string;
  agent: {
    id: string;
    firstname: string;
    lastname: string;
    email: string;
    phone: string;
    status: string;
  };
}

// A real hash, so a login for an unknown email costs the same as a real one.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

// Status errors (SUSPENDED / DEACTIVATED) are only revealed after the password is
// confirmed, so a legitimate agent gets a clear reason without leaking which emails exist.
async function loginAgent(email: string, password: string): Promise<AgentLoginResult> {
  const mail = email.toLowerCase().trim();
  const lockKey = `agent:${mail}`;
  if (await isLocked(lockKey)) throw new Error("TOO_MANY_ATTEMPTS");

  const agent = await prisma.agent.findUnique({
    where: { email: mail },
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

  const passwordMatch = await bcrypt.compare(password, agent?.password ?? DUMMY_HASH);
  if (!agent || !passwordMatch) {
    recordFailure(lockKey);
    logger.warn({ email: mail }, "agent.login_invalid_credentials");
    throw new Error("INVALID_CREDENTIALS");
  }
  clearFailures(lockKey);

  if (agent.status !== "ACTIVE") {
    logger.warn({ agentId: agent.id, status: agent.status }, "agent.login_blocked_by_status");
    throw new Error(agent.status === "SUSPENDED" ? "AGENT_SUSPENDED" : "AGENT_DEACTIVATED");
  }

  const payload = { userId: agent.id, role: "AGENT" as const, email: agent.email };
  const token = signAccessToken(payload);
  const refreshToken = await issueRefreshToken(payload);

  logger.info({ agentId: agent.id }, "agent.login_success");

  return {
    token,
    refreshToken,
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