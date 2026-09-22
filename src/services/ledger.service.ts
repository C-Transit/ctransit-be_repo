"use strict";

import crypto from "crypto";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";
import env from "../config/env.js";
import { INITIAL_FARE_CONFIGS } from "./fare.service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export type RideRejectionReason =
  | "CARD_NOT_MAPPED"
  | "DRIVER_NOT_FOUND"
  | "DRIVER_NOT_AUTHORIZED"
  | "TERMINAL_NOT_FOUND"
  | "LOCATION_MISMATCH"
  | "INVALID_LOCATION"
  | "FARE_MISMATCH"
  | "FARE_CONFIG_MISSING"
  | "INSUFFICIENT_FUNDS"
  | "DUPLICATE_TRANSACTION"
  | "MALFORMED_TRANSACTION"
  | "STUDENT_WALLET_NOT_FOUND"
  | "INVALID_FARE"
  | "INVALID_TIMESTAMP";

interface DeductionResult {
  newBalance: number | null;
  walletFound: boolean;
  insufficientFunds?: boolean;
  alreadyProcessed?: boolean;
}

interface CreditResult {
  previousBalance: number;
  newBalance: number;
}

// Ride Settlement Configuration
const DRIVER_SPLIT_RATIO = 0.96;
const CTRANSIT_SPLIT_RATIO = 0.04;

export interface FareSplit {
  fare: number;
  driverShare: number;
  ctransitShare: number;
}

function calculateFareSplit(fare: number): FareSplit {
  // Round driver share to 2 decimal places
  const driverShare = Math.round(fare * DRIVER_SPLIT_RATIO * 100) / 100;
  // Platform gets the exact remainder to prevent rounding leakage
  const ctransitShare = Math.round((fare - driverShare) * 100) / 100;

  return {
    fare,
    driverShare,
    ctransitShare,
  };
}

export interface SettleRideParams {
  transactionId?: string;
  idempotencyKey?: string;
  studentUid: string;
  terminalId: string;
  fare: number;
  rawAmount?: number | string | null;
  driverUid?: string | null;
  syncedAt?: Date;
  tappedAt?: Date | number | null;
  timestamp?: number | string | null;
  location?: string | null;
  cardUid?: string | null;
  protocolVersion?: string | null;
}

export interface SettleRideResult {
  success: boolean;
  alreadyProcessed?: boolean;
  insufficientFunds?: boolean;
  error?: string;
  rejectionReason?: RideRejectionReason | string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction?: any;
  studentBalance?: number;
  driverBalance?: number;
  ctransitBalance?: number;
  fareSplit?: FareSplit;
}


function generateTransactionFingerprint(params: {
  protocolVersion?: string | null;
  terminalId: string;
  cardUid: string;
  rawAmount: number | string;
  timestamp: number | string | Date;
  driverUid?: string | null;
  location?: string | null;
}): string {
  const version = params.protocolVersion || "v1.1.0L";
  const deviceId = (params.terminalId || "").trim();
  const cardUid = (params.cardUid || "").trim().toUpperCase();
  const rawAmount = String(
    params.rawAmount !== undefined && params.rawAmount !== null
      ? params.rawAmount
      : ""
  ).trim();

  let tsStr: string;
  if (params.timestamp instanceof Date) {
    tsStr = String(Math.floor(params.timestamp.getTime() / 1000));
  } else {
    tsStr = String(params.timestamp ?? "").trim();
  }

  const driverUid = (params.driverUid || "").trim().toUpperCase();
  const location = (params.location || "").trim().toUpperCase();

  const rawIdentity = `${version}:${deviceId}:${cardUid}:${rawAmount}:${tsStr}:${driverUid}:${location}`;
  return crypto.createHash("sha256").update(rawIdentity).digest("hex");
}

/**
 * Resolves a student's matricNumber from a physical NFC card UID via CardMapping.
 */
async function resolveStudentMatricFromCard(
  cardUid: string,
  dbClient: DbClient = prisma
): Promise<string | null> {
  const normUid = (cardUid || "").trim().toUpperCase();
  const mapping = await dbClient.cardMapping.findUnique({
    where: { card_uid: normUid },
    select: { student_uid: true },
  });
  return mapping ? mapping.student_uid : null;
}

async function deductFare(
  studentUid: string,
  amount: number,
  transactionId: string,
  dbClient: DbClient = prisma
): Promise<DeductionResult> {
  const childLogger = logger.child({ transactionId, studentUid, amount });
  const wallet = await dbClient.wallet.findUnique({
    where: { student_uid: studentUid },
    select: { balance: true },
  });

  if (!wallet) {
    childLogger.warn("ledger.wallet_not_found — skipping deduction");
    return { newBalance: null, walletFound: false };
  }

  // Idempotency check: verify transaction doesn't already exist to prevent double-charging
  const checkClient = dbClient as unknown as {
    transaction?: {
      findUnique?: (args: { where: { transaction_id: string } }) => Promise<unknown>;
    };
  };
  if (checkClient.transaction && typeof checkClient.transaction.findUnique === "function") {
    const existing = await checkClient.transaction.findUnique({
      where: { transaction_id: transactionId },
    });
    if (existing) {
      const currentBalance = parseFloat(wallet.balance.toString());
      childLogger.info("ledger.deduct_already_processed — idempotent skip");
      return { newBalance: currentBalance, walletFound: true, alreadyProcessed: true };
    }
  }

  const currentBalance = parseFloat(wallet.balance.toString());
  if (currentBalance < amount) {
    childLogger.warn(
      { currentBalance, amount },
      "ledger.insufficient_funds — skipping deduction to prevent negative balance"
    );
    return { newBalance: currentBalance, walletFound: true, insufficientFunds: true };
  }

  let newBalance: number;
  if (dbClient.wallet.updateMany) {
    const deductRes = await dbClient.wallet.updateMany({
      where: {
        student_uid: studentUid,
        balance: { gte: amount },
      },
      data: { balance: { decrement: amount } },
    });
    if (deductRes.count === 0) {
      const refreshed = await dbClient.wallet.findUnique({
        where: { student_uid: studentUid },
      });
      const bal = refreshed ? parseFloat(refreshed.balance.toString()) : currentBalance;
      childLogger.warn(
        { currentBalance: bal, amount },
        "ledger.insufficient_funds — skipping deduction to prevent negative balance"
      );
      return { newBalance: bal, walletFound: true, insufficientFunds: true };
    }
    const refreshed = await dbClient.wallet.findUnique({
      where: { student_uid: studentUid },
      select: { balance: true },
    });
    newBalance = refreshed ? parseFloat(refreshed.balance.toString()) : currentBalance - amount;
  } else {
    const updatedWallet = await dbClient.wallet.update({
      where: { student_uid: studentUid },
      data: { balance: { decrement: amount } },
      select: { balance: true },
    });
    newBalance = parseFloat(updatedWallet.balance.toString());
  }

  childLogger.info(
    { previousBalance: currentBalance, newBalance },
    "ledger.fare_deducted"
  );
  return { newBalance, walletFound: true };
}

async function settleRideTransaction(
  params: SettleRideParams,
  dbClient: DbClient = prisma
): Promise<SettleRideResult> {
  const {
    studentUid,
    terminalId,
    fare,
    driverUid,
    syncedAt,
    location,
    cardUid,
    rawAmount,
    timestamp,
    tappedAt,
    protocolVersion,
  } = params;

  const childLogger = logger.child({
    transactionId: params.transactionId,
    studentUid,
    terminalId,
    fare,
    driverUid,
    location,
    cardUid,
  });

  if (typeof fare !== "number" || isNaN(fare) || fare <= 0) {
    childLogger.warn({ fare }, "ledger.settle_invalid_fare");
    return {
      success: false,
      error: "INVALID_FARE",
      rejectionReason: "INVALID_FARE",
    };
  }

  const effectiveStudentUid = (studentUid || cardUid || "").trim();
  const effectiveTerminalId = (terminalId || "").trim();

  if (!effectiveStudentUid || !effectiveTerminalId) {
    childLogger.warn("ledger.settle_malformed_transaction");
    return {
      success: false,
      error: "MALFORMED_TRANSACTION",
      rejectionReason: "MALFORMED_TRANSACTION",
    };
  }

  const isV110L = Boolean(
    cardUid || location || protocolVersion === "v1.1.0L"
  );

  // Parse tapped_at from timestamp or tappedAt
  const syncedAtDate = syncedAt || new Date();
  let tappedAtDate: Date | null = null;
  if (tappedAt instanceof Date) {
    tappedAtDate = tappedAt;
  } else if (typeof tappedAt === "number") {
    tappedAtDate =
      tappedAt > 1e11 ? new Date(tappedAt) : new Date(tappedAt * 1000);
  } else if (timestamp !== undefined && timestamp !== null) {
    const tsNum =
      typeof timestamp === "number"
        ? timestamp
        : parseInt(String(timestamp), 10);
    if (!isNaN(tsNum)) {
      tappedAtDate = tsNum > 1e11 ? new Date(tsNum) : new Date(tsNum * 1000);
    }
  }

  // Validate timestamp if explicitly provided
  if (timestamp !== undefined && timestamp !== null) {
    const tsNum =
      typeof timestamp === "number"
        ? timestamp
        : parseInt(String(timestamp), 10);

    if (isNaN(tsNum) || tsNum <= 0) {
      childLogger.warn(
        { timestamp },
        "ledger.invalid_timestamp — invalid epoch timestamp"
      );
      return {
        success: false,
        error: "INVALID_TIMESTAMP",
        rejectionReason: "INVALID_TIMESTAMP",
      };
    }
  } else if (protocolVersion === "v1.1.0L" && timestamp === null) {
    return {
      success: false,
      error: "INVALID_TIMESTAMP",
      rejectionReason: "INVALID_TIMESTAMP",
    };
  }

  // Deterministic Idempotency Key Computation
  const effectiveVersion = protocolVersion || (location ? "v1.1.0L" : "v1.0");
  const effectiveCardUid = cardUid || effectiveStudentUid;
  const effectiveTimestamp =
    timestamp !== undefined && timestamp !== null
      ? timestamp
      : tappedAtDate
      ? Math.floor(tappedAtDate.getTime() / 1000)
      : null;

  let idempotencyKey = params.idempotencyKey || null;
  if (!idempotencyKey && effectiveTimestamp !== null) {
    idempotencyKey = generateTransactionFingerprint({
      protocolVersion: effectiveVersion,
      terminalId,
      cardUid: effectiveCardUid,
      rawAmount:
        rawAmount !== undefined && rawAmount !== null ? rawAmount : fare,
      timestamp: effectiveTimestamp,
      driverUid,
      location,
    });
  }

  const transactionId =
    params.transactionId || idempotencyKey || `${terminalId}-${Date.now()}`;

  // Helper to find existing transaction in client
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findExistingTx = async (client: any) => {
    if (!client || !client.transaction) return null;
    let found = null;
    if (typeof client.transaction.findUnique === "function") {
      found = await client.transaction
        .findUnique({
          where: { transaction_id: transactionId },
        })
        .catch(() => null);
      if (!found && idempotencyKey && idempotencyKey !== transactionId) {
        found = await client.transaction
          .findUnique({
            where: { idempotency_key: idempotencyKey },
          })
          .catch(() => null);
      }
    }
    if (!found && typeof client.transaction.findFirst === "function") {
      found = await client.transaction
        .findFirst({
          where: {
            OR: [
              { transaction_id: transactionId },
              ...(idempotencyKey ? [{ idempotency_key: idempotencyKey }] : []),
            ],
          },
        })
        .catch(() => null);
    }
    return found;
  };

  // Fast pre-check for idempotency before starting transaction
  const existing = await findExistingTx(dbClient);
  if (existing) {
    childLogger.info("ledger.settle_already_processed — idempotent skip");
    return {
      success: true,
      alreadyProcessed: true,
      transaction: existing,
    };
  }

  const split = calculateFareSplit(fare);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeAtomic = async (tx: any): Promise<SettleRideResult> => {
    // Re-check idempotency within the transaction lock
    const txExisting = await findExistingTx(tx);
    if (txExisting) {
      return {
        success: true,
        alreadyProcessed: true,
        transaction: txExisting,
      };
    }

        // 1. Location Validation
        let normLocation: string | null = null;
    if (location !== undefined && location !== null && location !== "") {
      normLocation = location.trim().toUpperCase();
      const VALID_LOCATIONS = ["A", "B", "C"];
      if (!VALID_LOCATIONS.includes(normLocation)) {
        childLogger.warn(
          { location: normLocation },
          "ledger.invalid_location — rejecting ride"
        );
        return {
          success: false,
          error: "INVALID_LOCATION",
          rejectionReason: "INVALID_LOCATION",
        };
      }
    } else if (isV110L) {
      childLogger.warn("ledger.missing_location — v1.1.0L requires location");
      return {
        success: false,
        error: "INVALID_LOCATION",
        rejectionReason: "INVALID_LOCATION",
      };
    }

        // 2. Fare Validation (FareConfig is source of truth, fail closed)
        if (normLocation) {
      let expectedFare: number;
      const fareTable = tx.fareConfig || dbClient.fareConfig;
      if (fareTable && typeof fareTable.findUnique === "function") {
        const fareRecord = await fareTable.findUnique({
          where: { code: normLocation, location_code: normLocation },
        });
        if (!fareRecord) {
          childLogger.warn(
            { location: normLocation },
            "ledger.fare_config_missing — no FareConfig found for location"
          );
          return {
            success: false,
            error: "FARE_CONFIG_MISSING",
            rejectionReason: "FARE_CONFIG_MISSING",
          };
        }
        expectedFare = parseFloat(fareRecord.amount.toString());
      } else {
        const initialDef = INITIAL_FARE_CONFIGS[normLocation];
        if (initialDef) {
          expectedFare = initialDef.amount;
        } else {
          childLogger.warn(
            { location: normLocation },
            "ledger.fare_config_missing — no FareConfig found"
          );
          return {
            success: false,
            error: "FARE_CONFIG_MISSING",
            rejectionReason: "FARE_CONFIG_MISSING",
          };
        }
      }

      if (expectedFare !== null && fare !== expectedFare) {
        childLogger.warn(
          { location: normLocation, expectedFare, receivedFare: fare },
          "ledger.fare_mismatch — received fare does not match FareConfig"
        );
        return {
          success: false,
          error: "FARE_MISMATCH",
          rejectionReason: "FARE_MISMATCH",
        };
      }
    }

        // 3. Terminal & Driver Authorization Validation
        const terminalTable = tx.terminal || dbClient.terminal;
    const normalisedDriverUid = driverUid
      ? driverUid.trim().toUpperCase()
      : null;

    if (terminalTable && typeof terminalTable.findUnique === "function") {
      const terminal = await terminalTable.findUnique({
        where: { terminal_id: terminalId },
      });

      if (!terminal) {
        childLogger.warn(
          { terminalId },
          "ledger.terminal_not_found — rejecting ride"
        );
        return {
          success: false,
          error: "TERMINAL_NOT_FOUND",
          rejectionReason: "TERMINAL_NOT_FOUND",
        };
      }

      // Check terminal location if payload location was provided
      if (normLocation) {
        const terminalLoc = terminal.location
          ? terminal.location.trim().toUpperCase()
          : null;
        if (terminalLoc && terminalLoc !== normLocation) {
          childLogger.warn(
            { payloadLocation: normLocation, terminalLocation: terminalLoc },
            "ledger.location_mismatch — payload location does not match terminal"
          );
          return {
            success: false,
            error: "LOCATION_MISMATCH",
            rejectionReason: "LOCATION_MISMATCH",
          };
        }
      }

      // Terminal has an authorized active driver
      if (!terminal.active_driver_uid) {
        childLogger.warn(
          { terminalId },
          "ledger.terminal_has_no_active_driver — rejecting ride"
        );
        return {
          success: false,
          error: "DRIVER_NOT_AUTHORIZED",
          rejectionReason: "DRIVER_NOT_AUTHORIZED",
        };
      }

      // Check if driver was supplied in payload
      if (!normalisedDriverUid) {
        childLogger.warn(
          { terminalId },
          "ledger.driver_not_found — payload missing driver_uid"
        );
        return {
          success: false,
          error: "DRIVER_NOT_FOUND",
          rejectionReason: "DRIVER_NOT_FOUND",
        };
      }

      // Payload driver must match server-side terminal active driver
      if (
        terminal.active_driver_uid.trim().toUpperCase() !== normalisedDriverUid
      ) {
        childLogger.warn(
          {
            payloadDriver: normalisedDriverUid,
            terminalActiveDriver: terminal.active_driver_uid,
          },
          "ledger.driver_not_authorized — payload driver does not match terminal assignment"
        );
        return {
          success: false,
          error: "DRIVER_NOT_AUTHORIZED",
          rejectionReason: "DRIVER_NOT_AUTHORIZED",
        };
      }
    }

    // Driver existence & role check in users table
    const userTable = tx.user || dbClient.user;
    if (
      normalisedDriverUid &&
      userTable &&
      typeof userTable.findUnique === "function"
    ) {
      const driverUser = await userTable.findUnique({
        where: { matricNumber: normalisedDriverUid },
        select: { id: true, role: true, matricNumber: true },
      });

      if (!driverUser) {
        childLogger.warn(
          { driverUid: normalisedDriverUid },
          "ledger.driver_not_found — driver user does not exist"
        );
        return {
          success: false,
          error: "DRIVER_NOT_FOUND",
          rejectionReason: "DRIVER_NOT_FOUND",
        };
      }

      if (
        driverUser.role &&
        driverUser.role !== "DRIVER" &&
        driverUser.role !== "driver"
      ) {
        childLogger.warn(
          { driverUid: normalisedDriverUid, role: driverUser.role },
          "ledger.driver_not_authorized — user does not have DRIVER role"
        );
        return {
          success: false,
          error: "DRIVER_NOT_AUTHORIZED",
          rejectionReason: "DRIVER_NOT_AUTHORIZED",
        };
      }
    }

        // 4. Card UID -> Student Resolution
        const rawCardUid = cardUid || (isV110L ? effectiveStudentUid : null);

    let resolvedStudentMatric = effectiveStudentUid;
    let resolvedCardUid: string | null = rawCardUid;

    const cardMappingTable = tx.cardMapping || dbClient.cardMapping;
    if (
      cardMappingTable &&
      typeof cardMappingTable.findUnique === "function"
    ) {
      const lookupUid = (rawCardUid || effectiveStudentUid || "").trim().toUpperCase();
      const mapping = await cardMappingTable.findUnique({
        where: { card_uid: lookupUid },
        select: { student_uid: true },
      });

      if (mapping) {
        resolvedStudentMatric = mapping.student_uid;
        resolvedCardUid = lookupUid;
      } else if (isV110L) {
        childLogger.warn(
          { cardUid: lookupUid },
          "ledger.card_not_mapped — rejecting ride"
        );
        return {
          success: false,
          error: "CARD_NOT_MAPPED",
          rejectionReason: "CARD_NOT_MAPPED",
        };
      }
    } else if (isV110L && cardUid) {
      childLogger.warn(
        { cardUid },
        "ledger.card_not_mapped — no mapping table available"
      );
      return {
        success: false,
        error: "CARD_NOT_MAPPED",
        rejectionReason: "CARD_NOT_MAPPED",
      };
    }

        // 5. Student Wallet Balance Check & Debit
        const studentWallet = await tx.wallet.findUnique({
      where: { student_uid: resolvedStudentMatric },
      select: { balance: true },
    });

    if (!studentWallet) {
      childLogger.warn(
        { resolvedStudentMatric, originalStudentUid: studentUid },
        "ledger.settle_student_wallet_not_found"
      );
      return {
        success: false,
        error: "STUDENT_WALLET_NOT_FOUND",
        rejectionReason: "STUDENT_WALLET_NOT_FOUND",
      };
    }

    const currentStudentBalance = parseFloat(studentWallet.balance.toString());
    if (currentStudentBalance < fare) {
      childLogger.warn(
        { currentStudentBalance, fare },
        "ledger.settle_insufficient_funds — rejected to prevent negative student balance"
      );
      return {
        success: false,
        insufficientFunds: true,
        error: "INSUFFICIENT_FUNDS",
        rejectionReason: "INSUFFICIENT_FUNDS",
        studentBalance: currentStudentBalance,
      };
    }

    // Atomic Student Debit
    let newStudentBalance: number;
    if (tx.wallet.updateMany) {
      const debitResult = await tx.wallet.updateMany({
        where: {
          student_uid: resolvedStudentMatric,
          balance: { gte: fare },
        },
        data: { balance: { decrement: fare } },
      });

      if (debitResult.count === 0) {
        const refreshed = await tx.wallet.findUnique({
          where: { student_uid: resolvedStudentMatric },
          select: { balance: true },
        });
        const currentBal = refreshed
          ? parseFloat(refreshed.balance.toString())
          : currentStudentBalance;
        childLogger.warn(
          { currentStudentBalance: currentBal, fare },
          "ledger.settle_insufficient_funds — rejected concurrent double-spend"
        );
        return {
          success: false,
          insufficientFunds: true,
          error: "INSUFFICIENT_FUNDS",
          rejectionReason: "INSUFFICIENT_FUNDS",
          studentBalance: currentBal,
        };
      }

      const refreshed = await tx.wallet.findUnique({
        where: { student_uid: resolvedStudentMatric },
        select: { balance: true },
      });
      newStudentBalance = refreshed
        ? parseFloat(refreshed.balance.toString())
        : currentStudentBalance - fare;
    } else {
      const updatedStudentWallet = await tx.wallet.update({
        where: { student_uid: resolvedStudentMatric },
        data: { balance: { decrement: fare } },
        select: { balance: true },
      });
      newStudentBalance = parseFloat(updatedStudentWallet.balance.toString());
    }

        // 6. Driver Credit (96% share)
        let driverBalance = 0;
    if (normalisedDriverUid && tx.driverWallet) {
      const updatedDriverWallet = await tx.driverWallet.upsert({
        where: { driver_uid: normalisedDriverUid },
        create: {
          driver_uid: normalisedDriverUid,
          balance: split.driverShare,
          total_earnings: split.driverShare,
        },
        update: {
          balance: { increment: split.driverShare },
          total_earnings: { increment: split.driverShare },
        },
        select: { balance: true },
      });
      driverBalance = parseFloat(updatedDriverWallet.balance.toString());
    }

        // 7. C-Transit Platform Credit (4% share)
        let ctransitBalance = 0;
    if (tx.systemWallet) {
      const updatedSystemWallet = await tx.systemWallet.upsert({
        where: { id: "CTRANSIT_SYSTEM" },
        create: {
          id: "CTRANSIT_SYSTEM",
          name: "C-Transit Platform",
          balance: split.ctransitShare,
          total_revenue: split.ctransitShare,
        },
        update: {
          balance: { increment: split.ctransitShare },
          total_revenue: { increment: split.ctransitShare },
        },
        select: { balance: true },
      });
      ctransitBalance = parseFloat(updatedSystemWallet.balance.toString());
    }

        // 8. Create Transaction Record
        const transaction = await tx.transaction.create({
      data: {
        transaction_id: transactionId,
        idempotency_key: idempotencyKey,
        type: "RIDE",
        terminal_id: terminalId,
        student_uid: resolvedStudentMatric,
        card_uid: resolvedCardUid,
        location: normLocation || location || null,
        amount: fare,
        fare: fare,
        driver_share: split.driverShare,
        ctransit_share: split.ctransitShare,
        driver_uid: normalisedDriverUid,
        tapped_at: tappedAtDate,
        synced_at: syncedAtDate,
      },
    });

    childLogger.info(
      {
        transactionId,
        idempotencyKey,
        fare,
        driverShare: split.driverShare,
        ctransitShare: split.ctransitShare,
        newStudentBalance,
        driverBalance,
        ctransitBalance,
      },
      "ledger.ride_settled_successfully"
    );

    return {
      success: true,
      transaction,
      studentBalance: newStudentBalance,
      driverBalance,
      ctransitBalance,
      fareSplit: split,
    };
  };

  try {
    if (
      "$transaction" in dbClient &&
      typeof dbClient.$transaction === "function"
    ) {
      return await dbClient.$transaction(executeAtomic);
    } else {
      return await executeAtomic(dbClient);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "SETTLEMENT_FAILED";
    // Check if error was due to concurrent race on unique transaction_id or idempotency_key
    if (
      message.includes("Unique constraint") ||
      message.includes("P2002") ||
      message.includes("duplicate key") ||
      (error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "P2002")
    ) {
      const settled = await findExistingTx(dbClient);
      if (settled) {
        childLogger.info(
          "ledger.settle_already_processed — idempotent skip on concurrent race"
        );
        return {
          success: true,
          alreadyProcessed: true,
          transaction: settled,
        };
      }
    }
    childLogger.error({ err: message }, "ledger.settle_ride_error");
    return {
      success: false,
      error: message,
    };
  }
}

function isBelowThreshold(balance: number): boolean {
  return balance < env.ledger.baseFare;
}

function hasCrossedAboveThreshold(
  previousBalance: number,
  newBalance: number
): boolean {
  return (
    previousBalance < env.ledger.baseFare && newBalance >= env.ledger.baseFare
  );
}

async function activateWallet(studentUid: string): Promise<void> {
  await prisma.wallet.upsert({
    where: { student_uid: studentUid },
    update: { is_linked: true },
    create: { student_uid: studentUid, balance: 0, is_linked: true },
  });
  logger.info({ studentUid }, "ledger.wallet_activated");
}

async function creditWallet(
  studentUid: string,
  amount: number,
  reference?: string, // <-- new: optional transaction reference
  dbClient = prisma
): Promise<CreditResult | null> {
  const wallet = await dbClient.wallet.findUnique({
    where: { student_uid: studentUid },
    select: { balance: true },
  });

  if (!wallet) {
    logger.warn({ studentUid }, "ledger.credit_wallet_not_found");
    return null;
  }

  // Generate a reference if not provided
  const txRef =
    reference ??
    `TOPUP-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;

  // Idempotency check: if transaction reference already exists, do not double-credit!
  const txCheckClient = dbClient as unknown as {
    transaction?: {
      findUnique?: (args: { where: { transaction_id: string } }) => Promise<unknown>;
    };
  };
  if (txCheckClient.transaction && typeof txCheckClient.transaction.findUnique === "function") {
    const existing = await txCheckClient.transaction.findUnique({
      where: { transaction_id: txRef },
    });
    if (existing) {
      const currentBalance = parseFloat(wallet.balance.toString());
      logger.info(
        { studentUid, txRef },
        "ledger.credit_wallet_already_processed — idempotent skip"
      );
      return { previousBalance: currentBalance, newBalance: currentBalance };
    }
  }

  // Perform the credit and create transaction in a single Prisma transaction
  const [updatedWallet] = await dbClient.$transaction([
    dbClient.wallet.update({
      where: { student_uid: studentUid },
      data: { balance: { increment: amount } },
      select: { balance: true },
    }),
    dbClient.transaction.create({
      data: {
        transaction_id: txRef,
        type: "TOPUP",
        terminal_id: "SYSTEM_TERMINAL", // <-- use a dedicated system terminal
        student_uid: studentUid,
        amount: amount,
        driver_uid: null, // not applicable for top-ups
        synced_at: new Date(),
      },
    }),
  ]);

  const previousBalance = parseFloat(wallet.balance.toString());
  const newBalance = parseFloat(updatedWallet.balance.toString());

  logger.info(
    { studentUid, previousBalance, newBalance, amount, reference: txRef },
    "ledger.wallet_credited"
  );

  return { previousBalance, newBalance };
}

export {
  deductFare,
  settleRideTransaction,
  resolveStudentMatricFromCard,
  generateTransactionFingerprint,
  calculateFareSplit,
  DRIVER_SPLIT_RATIO,
  CTRANSIT_SPLIT_RATIO,
  isBelowThreshold,
  hasCrossedAboveThreshold,
  activateWallet,
  creditWallet,
  prisma,
};
