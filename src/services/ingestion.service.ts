"use strict";

import { prisma, isBelowThreshold } from "./ledger.service.js";
import type { Prisma } from "@prisma/client";
import logger from "../config/logger.js";
import {
  parseTransactionBatch,
  buildDeltaCommand,
  type ParsedTransaction,
} from "../utils/parser.js";
import { enqueueBroadcast } from "../utils/bridge.js";
import { enqueueRoute } from "../utils/bridge.js";
import {
  getRedisClient,
  cacheKeys,
  WALLET_CACHE_TTL,
  BLACKLIST_CACHE_TTL,
} from "../config/redis.js";

type LoggerInstance = typeof logger;

// ── Cached wallet shape ───────────────────────────────────────────────────────
interface CachedWallet {
  balance: number;
  is_linked: boolean;
}

// ── Cache Helper: Card Mapping ────────────────────────────────────────────────

/**
 * Resolves a hardware card UID to a student matricNumber.
 * Cache-first — falls back to DB on miss and populates the cache.
 * No TTL — card mappings are permanent; invalidated only on card re-link
 * in registration.service.ts.
 *
 * @param cardUid - Raw hardware card UID from terminal e.g. "238DB4E8"
 * @returns matricNumber string or null if card is not registered
 */
async function resolveCardUid(cardUid: string): Promise<string | null> {
  const redis = getRedisClient();
  const key = cacheKeys.cardMap(cardUid);

  // Cache hit — return immediately without touching DB
  const cached = await redis.get(key);
  if (cached) return cached as string;

  // Cache miss — query DB
  const mapping = await prisma.cardMapping.findUnique({
    where: { card_uid: cardUid },
    select: { student_uid: true },
  });

  if (!mapping) return null;

  // Populate cache with no TTL — permanent until card is re-linked
  await redis.set(key, mapping.student_uid);

  return mapping.student_uid;
}

// ── Cache Helper: Wallet ──────────────────────────────────────────────────────

/**
 * Fetches wallet data for a student.
 * Cache-first — falls back to DB on miss and populates the cache.
 * TTL: 30 seconds — invalidated after every deduction and top-up.
 *
 * @param matricNumber - Student's matric number e.g. "2022/1/87453LH"
 * @returns CachedWallet or null if wallet does not exist
 */
async function getWalletCached(
  matricNumber: string
): Promise<CachedWallet | null> {
  const redis = getRedisClient();
  const key = cacheKeys.wallet(matricNumber);

  // Cache hit
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as CachedWallet;

  // Cache miss — query DB
  const wallet = await prisma.wallet.findUnique({
    where: { student_uid: matricNumber },
    select: { balance: true, is_linked: true },
  });

  if (!wallet) return null;

  // Populate cache with 30s TTL
  const walletData: CachedWallet = {
    balance: parseFloat(wallet.balance.toString()),
    is_linked: wallet.is_linked,
  };
  await redis.setex(key, WALLET_CACHE_TTL, JSON.stringify(walletData));

  return walletData;
}

// ── Cache Helper: Blacklist ───────────────────────────────────────────────────

/**
 * Checks if a student is on the blacklist.
 * Cache-first — falls back to DB on miss and populates the cache.
 * TTL: 60 seconds — invalidated when blacklist status changes.
 * Stores "1" = blacklisted, "0" = clean to avoid null ambiguity.
 *
 * @param matricNumber
 * @returns true if blacklisted, false if clean
 */
async function isBlacklistedCached(matricNumber: string): Promise<boolean> {
  const redis = getRedisClient();
  const key = cacheKeys.blacklist(matricNumber);

  // Cache hit — "1" means blacklisted, "0" means clean
  const cached = await redis.get(key);
  if (cached !== null) return cached === "1";

  // Cache miss — query DB
  const blacklisted = await prisma.blacklist.findUnique({
    where: { student_uid: matricNumber },
    select: { student_uid: true },
  });

  // Populate cache with 60s TTL
  await redis.setex(key, BLACKLIST_CACHE_TTL, blacklisted ? "1" : "0");

  return !!blacklisted;
}

// ── Cache Invalidation Helpers ────────────────────────────────────────────────

/**
 * Deletes the wallet cache entry for a student.
 * Called after every balance change so the next tap reads fresh data from DB.
 */
async function invalidateWalletCache(matricNumber: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(cacheKeys.wallet(matricNumber));
}

/**
 * Deletes the blacklist cache entry for a student.
 * Called after blacklist status changes (added or removed).
 */
async function invalidateBlacklistCache(matricNumber: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(cacheKeys.blacklist(matricNumber));
}

// ── Main Ingestion Logic ──────────────────────────────────────────────────────

async function ingestTransactionBatch(
  terminalId: string,
  rawPayload: string
): Promise<void> {
  const log = logger.child({ terminalId });
  log.info({ payloadLength: rawPayload.length }, "ingestion.batch_received");

  const { valid, invalid } = parseTransactionBatch(rawPayload, terminalId);

  if (invalid.length > 0) {
    log.warn({ invalidRows: invalid }, "ingestion.invalid_rows_skipped");
  }

  if (valid.length === 0) {
    log.warn("ingestion.no_valid_rows");
    return;
  }

  for (const tx of valid) {
    await processTransaction(tx, terminalId, log);
  }

  log.info({ processedCount: valid.length }, "ingestion.batch_complete");
}

async function processTransaction(
  tx: ParsedTransaction,
  terminalId: string,
  log: LoggerInstance
): Promise<void> {
  const txLog = log.child({
    transactionId: tx.transaction_id,
    cardUid: tx.student_uid, // Raw hardware card UID from terminal
  });

  try {
    // ── STEP 0: Resolve card UID → matricNumber (cached) ──────────────────
    // Terminal sends hardware UID e.g. "238DB4E8" — not the matric number.
    // resolveCardUid() checks Redis first, falls back to DB on miss.
    const matricNumber = await resolveCardUid(tx.student_uid);

    if (!matricNumber) {
      txLog.warn("ingestion.card_uid_not_registered");
      // ✅ Bug fix: was `cardMapping.card_uid` which crashes when cardMapping is null.
      // tx.student_uid is the raw card UID — always available here.
      await enqueueRoute(
        terminalId,
        `ACK:FAIL,${tx.student_uid},CARD_NOT_REGISTERED`
      );
      return;
    }

    txLog.info({ matricNumber }, "ingestion.card_uid_resolved");

    // ── CHECK 1: Is student whitelisted? (cached) ─────────────────────────
    // A student is whitelisted when wallet exists and is_linked = true.
    // is_linked is set to true when KYC is approved (kyc.service.ts approveKyc).
    const wallet = await getWalletCached(matricNumber);

    if (!wallet || !wallet.is_linked) {
      txLog.warn({ matricNumber }, "ingestion.student_not_whitelisted");
      await enqueueRoute(
        terminalId,
        `ACK:FAIL,${tx.student_uid},NOT_WHITELISTED`
      );
      return;
    }

    // ── CHECK 2: Is student blacklisted? (cached) ─────────────────────────
    // Blacklisted students have run out of balance from a previous ride.
    // They must top up via Monnify to be removed from the blacklist.
    const isBlacklisted = await isBlacklistedCached(matricNumber);

    if (isBlacklisted) {
      txLog.warn({ matricNumber }, "ingestion.student_is_blacklisted");
      await enqueueRoute(terminalId, `ACK:FAIL,${tx.student_uid},BLACKLISTED`);
      return;
    }

    // ─── CHECK 3 DISABLED (balance check) ────────────────────────────────
    // Restore this block when Monnify payment API is live:
    //
    // if (wallet.balance < tx.amount) {
    //   txLog.warn({ balance: wallet.balance, required: tx.amount }, "ingestion.insufficient_balance");
    //   await publishToTerminal(terminalId, `ACK:FAIL,${tx.student_uid},INSUFFICIENT_FUNDS`);
    //   await prisma.blacklist.upsert({ ... });
    //   await invalidateBlacklistCache(matricNumber);
    //   await broadcastDeltaToFleet(buildDeltaCommand("ADD", "BL", tx.student_uid));
    //   return;
    // }
    // ─────────────────────────────────────────────────────────────────────

    // currentBalance used for logging in fare_deducted below
    const currentBalance = wallet.balance;

    // Fetch active driver BEFORE opening transaction — avoids nested async in tx context
    const terminal = await prisma.terminal.findUnique({
      where: { terminal_id: terminalId },
      select: { active_driver_uid: true },
    });

    const driverUid = tx.driver_uid || terminal?.active_driver_uid || null;

    // ── All checks passed — deduct atomically ─────────────────────────────
    // 15s timeout — Neon cloud DB has network latency; default 5s is too short
    const result = await prisma.$transaction(
      async (tx_ctx: Prisma.TransactionClient) => {
        // Idempotency check — QoS 1 means terminal may resend the same batch
        const existingTx = await tx_ctx.transaction.findUnique({
          where: { transaction_id: tx.transaction_id },
        });

        if (existingTx) {
          txLog.debug("ingestion.duplicate_transaction_skipped");
          return { duplicate: true, newBalance: currentBalance };
        }

        // Record transaction — student_uid stores matricNumber not card UID
        await tx_ctx.transaction.create({
          data: {
            transaction_id: tx.transaction_id,
            type: "RIDE",
            terminal_id: tx.terminal_id,
            student_uid: matricNumber,
            amount: tx.amount,
            driver_uid: driverUid,
            synced_at: tx.synced_at,
          },
        });

        // Deduct fare from wallet
        const updatedWallet = await tx_ctx.wallet.update({
          where: { student_uid: matricNumber },
          data: { balance: { decrement: tx.amount } },
          select: { balance: true },
        });

        const newBalance = parseFloat(updatedWallet.balance.toString());

        txLog.info(
          {
            previousBalance: currentBalance,
            newBalance,
            driverUid,
            matricNumber,
          },
          "ingestion.fare_deducted"
        );

        return { duplicate: false, newBalance };
      },
      { timeout: 15000 }
    );

    if (result.duplicate) return;

    const { newBalance } = result;

    // ✅ Invalidate wallet cache — balance just changed, next tap must read fresh data
    await invalidateWalletCache(matricNumber);

    // ACK to terminal — use raw card UID, terminal identifies cards by hardware UID
    await enqueueRoute(
      terminalId,
      `ACK:OK,${tx.student_uid},${newBalance.toFixed(2)}`
    );
    txLog.info({ newBalance, matricNumber }, "ingestion.ack_sent_to_terminal");

    // ── Post-deduction blacklist check ────────────────────────────────────
    // Balance was sufficient but may have dropped below threshold after this ride.
    // Run asynchronously — does not block the ACK response to the terminal.
    if (isBelowThreshold(newBalance)) {
      const blacklistCmd = buildDeltaCommand("ADD", "BL", tx.student_uid);
      txLog.info(
        { newBalance, matricNumber },
        "ingestion.balance_now_below_threshold — blacklisting"
      );

      process.nextTick(async () => {
        try {
          // Add to blacklist DB
          await prisma.blacklist.upsert({
            where: { student_uid: matricNumber },
            update: { blacklistedAt: new Date() },
            create: { student_uid: matricNumber, reason: "LOW_BALANCE" },
          });

          // ✅ Invalidate blacklist cache — next tap must see blacklisted status
          await invalidateBlacklistCache(matricNumber);

          // Broadcast ADD:BL to all terminals
          await enqueueBroadcast(blacklistCmd);

          txLog.info({ blacklistCmd }, "ingestion.blacklist_broadcast_sent");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          txLog.error(
            { err: errMsg },
            "ingestion.post_deduction_blacklist_failed"
          );
        }
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    txLog.error({ err: errMsg }, "ingestion.transaction_processing_error");
    try {
      await enqueueRoute(terminalId, `ACK:FAIL,${tx.student_uid},SERVER_ERROR`);
    } catch (ackErr) {
      const ackErrMsg =
        ackErr instanceof Error ? ackErr.message : "Unknown error";
      txLog.error({ err: ackErrMsg }, "ingestion.ack_send_failed");
    }
  }
}

export { ingestTransactionBatch };
