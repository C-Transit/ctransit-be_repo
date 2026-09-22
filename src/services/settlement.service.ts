"use strict";

import { Decimal } from "@prisma/client/runtime/library";
import prisma from "../lib/prisma.js";
import logger from "../config/logger.js";

export interface SettleRideInput {
  transaction_id: string;
  terminal_id: string;
  student_uid: string;
  amount: number;
}

export type SettleRideResult =
  | { status: "SETTLED"; studentNewBalance: number; driverEarned: number; platformEarned: number }
  | { status: "ALREADY_SETTLED" }
  | { status: "INSUFFICIENT_BALANCE"; availableBalance: number; required: number }
  | { status: "STUDENT_NOT_FOUND" }
  | { status: "NO_ACTIVE_DRIVER" }
  | { status: "DRIVER_NOT_FOUND" }
  | { status: "TERMINAL_NOT_FOUND" };


function splitFare(amount: Decimal): { driverShare: Decimal; platformShare: Decimal } {
  const driverShare = amount.mul(96).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const platformShare = amount.sub(driverShare);
  return { driverShare, platformShare };
}

// settleRide — main entry point
export async function settleRide(input: SettleRideInput): Promise<SettleRideResult> {
  const { transaction_id, terminal_id, student_uid, amount } = input;
  const fareDecimal = new Decimal(amount);
  const log = logger.child({ transaction_id, terminal_id, student_uid, amount });

  // 1. Resolve terminal and server-side driver 
  const terminal = await prisma.terminal.findUnique({
    where: { terminal_id },
    select: { active_driver_uid: true },
  });

  if (!terminal) {
    log.warn("settlement.terminal_not_found");
    return { status: "TERMINAL_NOT_FOUND" };
  }

  if (!terminal.active_driver_uid) {
    log.warn("settlement.no_active_driver");
    return { status: "NO_ACTIVE_DRIVER" };
  }

  const driverUid = terminal.active_driver_uid;

  // Verify the active_driver_uid is a DRIVER-role user — guards against
  // stale terminal records pointing to a deleted or role-changed user
  const driver = await prisma.user.findFirst({
    where: { matricNumber: driverUid, role: "DRIVER" },
    select: { matricNumber: true },
  });

  if (!driver) {
    log.warn({ driverUid }, "settlement.driver_invalid_or_wrong_role");
    return { status: "DRIVER_NOT_FOUND" };
  }

  // 2. Resolve student wallet and validate balance
  const wallet = await prisma.wallet.findUnique({
    where: { student_uid },
    select: { balance: true },
  });

  if (!wallet) {
    log.warn("settlement.student_wallet_not_found");
    return { status: "STUDENT_NOT_FOUND" };
  }

  const currentBalance = wallet.balance;

  if (currentBalance.lt(fareDecimal)) {
    log.warn(
      { balance: currentBalance.toString(), required: fareDecimal.toString() },
      "settlement.insufficient_balance"
    );
    return {
      status: "INSUFFICIENT_BALANCE",
      availableBalance: parseFloat(currentBalance.toString()),
      required: amount,
    };
  }

  // 3. Compute revenue split
  const { driverShare, platformShare } = splitFare(fareDecimal);

  log.info(
    {
      fare: fareDecimal.toString(),
      driverShare: driverShare.toString(),
      platformShare: platformShare.toString(),
      driverUid,
    },
    "settlement.split_computed"
  );

  //  4. Atomic settlement
  try {
    const [updatedWallet] = await prisma.$transaction([
      // 4a. Debit student wallet
      prisma.wallet.update({
        where: { student_uid },
        data: { balance: { decrement: fareDecimal } },
        select: { balance: true },
      }),

      // 4b. Credit driver wallet (upsert — creates row on first ride)
      prisma.driverWallet.upsert({
        where: { driver_uid: driverUid },
        create: {
          driver_uid: driverUid,
          balance: driverShare,
          total_earned: driverShare,
        },
        update: {
          balance: { increment: driverShare },
          total_earned: { increment: driverShare },
        },
      }),

      // 4c. Credit platform wallet (singleton)
      prisma.systemWallet.upsert({
        where: { id: "CTRANSIT_SYSTEM" },
        create: {
          id: "CTRANSIT_SYSTEM",
          balance: platformShare,
          total_revenue: platformShare,
        },
        update: {
          balance: { increment: platformShare },
          total_revenue: { increment: platformShare },
        },
      }),

      // 4d. Create ride transaction record
      prisma.transaction.create({
        data: {
          transaction_id,
          type: "RIDE",
          terminal_id,
          student_uid,
          amount: fareDecimal,
          driver_uid: driverUid,
          synced_at: new Date(),
        },
      }),
    ]);

    const studentNewBalance = parseFloat(updatedWallet.balance.toString());

    log.info(
      {
        studentNewBalance,
        driverEarned: driverShare.toString(),
        platformEarned: platformShare.toString(),
      },
      "settlement.completed"
    );

    return {
      status: "SETTLED",
      studentNewBalance,
      driverEarned: parseFloat(driverShare.toString()),
      platformEarned: parseFloat(platformShare.toString()),
    };
  } catch (err: unknown) {
    // Duplicate transaction: idempotent no-op
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      log.info("settlement.already_settled — duplicate transaction_id ignored");
      return { status: "ALREADY_SETTLED" };
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err: errMsg }, "settlement.transaction_failed");
    throw err;
  }
}
