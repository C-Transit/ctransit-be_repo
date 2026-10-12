import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js";
import env from "../config/env.js";
import logger from "../config/logger.js";

type Role = "ADMIN" | "AGENT" | "STUDENT" | "DRIVER";

export interface RefreshTokenPayload {
  userId: string;
  role: Role;
  email: string;
}

const ACCESS_TTL = { STUDENT: "30m", DRIVER: "1h", ADMIN: "10m", AGENT: "30m" } as const;
const REFRESH_DAYS: Record<Role, number> = { STUDENT: 7, DRIVER: 7, ADMIN: 1, AGENT: 1 };

// The single place access tokens are signed. Lifetime depends on the role.
export const signAccessToken = ({ userId, role, email }: RefreshTokenPayload): string =>
  jwt.sign({ userId, role, email }, env.jwt.secret, { expiresIn: ACCESS_TTL[role], algorithm: "HS256" });

export const issueRefreshToken = async (payload: RefreshTokenPayload): Promise<string> => {
  const tokenId = randomUUID();
  const days = REFRESH_DAYS[payload.role];

  await prisma.refreshToken.create({
    data: {
      token_id: tokenId,
      user_id: payload.userId,
      role: payload.role,
      email: payload.email,
      expires_at: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    },
  });

  // Housekeeping: drop this user's expired tokens without blocking the response.
  prisma.refreshToken
    .deleteMany({ where: { user_id: payload.userId, expires_at: { lt: new Date() } } })
    .catch(() => {});

  return jwt.sign({ tokenId }, env.jwt.refreshSecret, { expiresIn: `${days}d` });
};

// Returns null if the token is invalid, unknown, revoked or expired.
export const verifyRefreshToken = async (
  token: string
): Promise<(RefreshTokenPayload & { tokenId: string }) | null> => {
  try {
    const { tokenId } = jwt.verify(token, env.jwt.refreshSecret, { algorithms: ["HS256"] }) as { tokenId: string };
    const stored = await prisma.refreshToken.findUnique({ where: { token_id: tokenId } });

    if (!stored || stored.revoked || stored.expires_at < new Date()) {
      logger.warn({ tokenId, found: !!stored, revoked: stored?.revoked }, "token.refresh_rejected");
      return null;
    }

    return { userId: stored.user_id, role: stored.role as Role, email: stored.email, tokenId };
  } catch {
    return null;
  }
};

export const revokeRefreshToken = async (tokenId: string): Promise<void> => {
  await prisma.refreshToken.updateMany({ where: { token_id: tokenId }, data: { revoked: true } });
};

// Call after a password or PIN change so existing sessions can't be refreshed.
export const revokeAllRefreshTokens = async (userId: string): Promise<void> => {
  await prisma.refreshToken.updateMany({ where: { user_id: userId, revoked: false }, data: { revoked: true } });
};