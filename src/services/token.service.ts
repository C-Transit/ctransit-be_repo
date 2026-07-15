// src/services/token.service.ts
// Refresh tokens now stored in PostgreSQL (refresh_tokens table)
// instead of Redis. Revocation is instant via the revoked flag.

import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import prisma from "../lib/prisma.js";
import env from "../config/env.js";
import logger from "../config/logger.js";

export interface RefreshTokenPayload {
  userId: string;
  role: "ADMIN" | "AGENT" | "STUDENT" | "DRIVER";
  email: string;
}

// ─────────────────────────────────────────────
// issueRefreshToken
// Generates a UUID tokenId, signs it into a JWT,
// and persists the payload to refresh_tokens table.
// Old expired tokens for this user are cleaned up
// on each new issue to prevent table bloat.
// ─────────────────────────────────────────────
export const issueRefreshToken = async (
  payload: RefreshTokenPayload
): Promise<string> => {
  const tokenId = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Persist to DB
  await prisma.refreshToken.create({
    data: {
      token_id: tokenId,
      user_id: payload.userId,
      role: payload.role,
      email: payload.email,
      expires_at: expiresAt,
    },
  });

  // Clean up expired tokens for this user — runs async, doesn't block
  prisma.refreshToken
    .deleteMany({
      where: {
        user_id: payload.userId,
        expires_at: { lt: new Date() },
      },
    })
    .catch(() => {});

  const refreshToken = jwt.sign({ tokenId }, env.jwt.refreshSecret, {
    expiresIn: "7d",
  });

  logger.debug({ userId: payload.userId, tokenId }, "token.refresh_issued");
  return refreshToken;
};

// ─────────────────────────────────────────────
// verifyRefreshToken
// Verifies JWT signature, extracts tokenId,
// looks up the token in DB.
// Returns null if invalid, expired, or revoked.
// ─────────────────────────────────────────────
export const verifyRefreshToken = async (
  token: string
): Promise<(RefreshTokenPayload & { tokenId: string }) | null> => {
  try {
    const decoded = jwt.verify(token, env.jwt.refreshSecret) as {
      tokenId: string;
    };

    const stored = await prisma.refreshToken.findUnique({
      where: { token_id: decoded.tokenId },
    });

    if (!stored) {
      logger.warn({ tokenId: decoded.tokenId }, "token.refresh_not_in_db");
      return null;
    }

    if (stored.revoked) {
      logger.warn({ tokenId: decoded.tokenId }, "token.refresh_revoked");
      return null;
    }

    if (stored.expires_at < new Date()) {
      logger.warn({ tokenId: decoded.tokenId }, "token.refresh_expired");
      return null;
    }

    return {
      userId: stored.user_id,
      role: stored.role as RefreshTokenPayload["role"],
      email: stored.email,
      tokenId: decoded.tokenId,
    };
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────
// revokeRefreshToken
// Marks the token as revoked in DB — instant
// invalidation. Called on logout.
//
// token.service.ts — update the exports at the bottom
export const revokeRefreshToken = async (tokenId: string): Promise<void> => {
  await prisma.refreshToken.updateMany({
    where: { token_id: tokenId },
    data: { revoked: true },
  });
  logger.debug({ tokenId }, "token.refresh_revoked");
};