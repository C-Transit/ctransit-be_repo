"use strict";

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "./ledger.service.js";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { issueRefreshToken } from "./token.service.js";
import { buildDeltaCommand } from "../utils/parser.js";
import { sendNotification } from "./notification.service.js";
import { enqueueRoute } from "../utils/bridge.js";
import { paymentContainer } from "../payments/payment.container.js";
import type { IPaymentGateway, PayoutParams } from "../payments/payment.interface.js";

export interface DriverRegisterData {
  firstname: string;
  lastname: string;
  matricNumber: string;
}

async function handleDriverRegister(
  terminalId: string,
  data: DriverRegisterData
) {
  const { firstname, lastname, matricNumber } = data;
  const log = logger.child({ terminalId, matricNumber });

  // Check if driver already exists
  const existing = await prisma.user.findUnique({
    where: { matricNumber: matricNumber.toUpperCase() },
  });

  if (existing) {
    log.warn("driver.already_registered");
    return {
      success: false,
      message: `${matricNumber} already registered`,
    };
  }

  const defaultPassword = `${matricNumber.replace(/\//g, "")}Driver!`;
  const hashedPassword = await bcrypt.hash(defaultPassword, 10);

  await prisma.user.create({
    data: {
      firstname,
      lastname,
      email: `-`,
      matricNumber: matricNumber.toUpperCase(),
      password: hashedPassword,
      role: "DRIVER",
      isVerified: true,
      driverWallet: {
        create: {
          balance: 0,
          total_earnings: 0,
        },
      },
    },
  });

  log.info({ firstname, lastname }, "driver.registered_from_terminal");

  return {
    success: true,
    message: `Driver ${firstname} ${lastname} registered`,
  };
}

async function handleDriverLogin(terminalId: string, driverUid: string) {
  const log = logger.child({ terminalId, driverUid });

  const driver = await prisma.user.findFirst({
    where: {
      matricNumber: driverUid.toUpperCase(),
      role: "DRIVER",
    },
    select: { id: true, firstname: true, lastname: true, matricNumber: true },
  });

  if (!driver) {
    log.warn("driver.not_found_or_not_driver_role");
    return { success: false, message: "Driver not recognised." };
  }

  await prisma.terminal.update({
    where: { terminal_id: terminalId },
    data: { active_driver_uid: driver.matricNumber },
  });

  log.info("driver.logged_into_terminal");

  return {
    success: true,
    message: `Welcome ${driver.firstname}`,
    driverName: `${driver.firstname} ${driver.lastname}`,
  };
}

async function handleDriverLogout(terminalId: string, driverUid: string) {
  const log = logger.child({ terminalId, driverUid });

  await prisma.terminal.update({
    where: { terminal_id: terminalId },
    data: { active_driver_uid: null },
  });

  log.info("driver.logged_out_of_terminal");
  return { success: true, message: "Driver logged out." };
}

export { handleDriverRegister, handleDriverLogin, handleDriverLogout };

async function listDrivers() {
  const [drivers, activeTerminals] = await Promise.all([
    prisma.user.findMany({
      where: { role: "DRIVER" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        matricNumber: true,
        createdAt: true,
        driverWallet: {
          select: {
            balance: true,
            total_earnings: true,
          },
        },
      },
    }),

    // Only fetch terminals that currently have a driver 
    prisma.terminal.findMany({
      where: { active_driver_uid: { not: null } },
      select: {
        terminal_id: true,
        status: true,
        active_driver_uid: true,
      },
    }),
  ]);

  // Map: matricNumber → terminal — O(1) lookups in the merge below
  const terminalByDriver = new Map(
    activeTerminals.map((t) => [t.active_driver_uid, t])
  );

  return drivers.map((driver) => ({
    ...driver,
    wallet: {
      balance: driver.driverWallet ? parseFloat(driver.driverWallet.balance.toString()) : 0,
      total_earnings: driver.driverWallet ? parseFloat(driver.driverWallet.total_earnings.toString()) : 0,
    },
    activeTerminal: terminalByDriver.get(driver.matricNumber) ?? null,
  }));
}

async function registerDriverByAgent(data: DriverRegisterData) {
  const { firstname, lastname, matricNumber } = data;
  const normalisedMatric = matricNumber.toUpperCase();

  const existing = await prisma.user.findUnique({
    where: { matricNumber: normalisedMatric },
    select: { id: true, role: true },
  });

  if (existing) {

    // Surface a clear error code — controller maps it to 409
    throw new Error(
      existing.role === "DRIVER"
        ? "DRIVER_ALREADY_EXISTS"
        : "MATRIC_NUMBER_IN_USE"
    );
  }

  const defaultPassword = `${normalisedMatric.replace(/\//g, "")}Driver!`;
  const hashedPassword = await bcrypt.hash(defaultPassword, 10);

  const driver = await prisma.user.create({
    data: {
      firstname: firstname.trim(),
      lastname: lastname.trim(),
      email: `-`,
      matricNumber: normalisedMatric,
      password: hashedPassword,
      role: "DRIVER",
      isVerified: true,
      driverWallet: {
        create: {
          balance: 0,
          total_earnings: 0,
        },
      },
    },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      matricNumber: true,
      createdAt: true,
      driverWallet: {
        select: {
          balance: true,
          total_earnings: true,
        },
      },
    },
  });

  logger.info(
    { matricNumber: driver.matricNumber },
    "driver.registered_by_agent"
  );

  return driver;
}

async function getDriverWallet(driverUid: string) {
  const normalised = driverUid.toUpperCase();
  const wallet = await prisma.driverWallet.findUnique({
    where: { driver_uid: normalised },
  });
  if (!wallet) {
    return {
      driver_uid: normalised,
      balance: 0,
      total_earnings: 0,
    };
  }
  return {
    driver_uid: wallet.driver_uid,
    balance: parseFloat(wallet.balance.toString()),
    total_earnings: parseFloat(wallet.total_earnings.toString()),
  };
}

async function loginDriver(identifier: string, password: string) {
  const trimmed = identifier.trim();
  const driver = await prisma.user.findFirst({
    where: {
      OR: [
        { email: trimmed.toLowerCase() },
        { matricNumber: trimmed.toUpperCase() },
      ],
      role: "DRIVER",
    },
  });

  if (!driver) {
    logger.warn({ identifier: trimmed }, "driver.login_not_found_or_not_driver");
    throw new Error("INVALID_CREDENTIALS");
  }

  const validPassword = await bcrypt.compare(password, driver.password);
  if (!validPassword) {
    logger.warn({ driverId: driver.id }, "driver.login_invalid_password");
    throw new Error("INVALID_CREDENTIALS");
  }

  const accessToken = jwt.sign(
    { userId: driver.id, role: driver.role, email: driver.email },
    env.jwt.secret,
    { expiresIn: "8h" }
  );

  const refreshToken = await issueRefreshToken({
    userId: driver.id,
    role: driver.role,
    email: driver.email,
  });

  const terminal = await prisma.terminal.findFirst({
    where: { active_driver_uid: driver.matricNumber },
    select: { terminal_id: true, status: true },
  });

  const profile = {
    id: driver.id,
    firstname: driver.firstname,
    lastname: driver.lastname,
    email: driver.email,
    matricNumber: driver.matricNumber,
    phone: driver.phone ?? null,
    role: driver.role,
    terminalId: terminal?.terminal_id ?? null,
    terminalStatus: terminal?.status ?? "OFFLINE",
    vehicleType: driver.vehicleType ?? null,
    vehiclePlate: driver.vehiclePlate ?? null,
    bankName: driver.bankName ?? null,
    accountNumber: driver.accountNumber ?? null,
  };

  logger.info({ driverId: driver.id, matricNumber: driver.matricNumber }, "driver.login_successful");

  return {
    accessToken,
    refreshToken,
    driver: profile,
  };
}

async function getDriverProfile(userId: string) {
  const driver = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  const terminal = await prisma.terminal.findFirst({
    where: { active_driver_uid: driver.matricNumber },
    select: { terminal_id: true, status: true },
  });

  return {
    id: driver.id,
    firstname: driver.firstname,
    lastname: driver.lastname,
    email: driver.email,
    matricNumber: driver.matricNumber,
    phone: driver.phone ?? null,
    role: driver.role,
    terminalId: terminal?.terminal_id ?? null,
    terminalStatus: terminal?.status ?? "OFFLINE",
    vehicleType: driver.vehicleType ?? null,
    vehiclePlate: driver.vehiclePlate ?? null,
    bankName: driver.bankName ?? null,
    accountNumber: driver.accountNumber ?? null,
  };
}

async function getDriverDashboard(userId: string) {
  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true, role: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [driverWallet, todayRidesCount, todayEarningsAgg, terminal] = await Promise.all([
    prisma.driverWallet.findUnique({
      where: { driver_uid: driver.matricNumber },
      select: { balance: true },
    }),
    prisma.transaction.count({
      where: {
        driver_uid: driver.matricNumber,
        type: "RIDE",
        synced_at: { gte: startOfToday },
      },
    }),
    prisma.transaction.aggregate({
      where: {
        driver_uid: driver.matricNumber,
        type: "RIDE",
        synced_at: { gte: startOfToday },
      },
      _sum: {
        driver_share: true,
      },
    }),
    prisma.terminal.findFirst({
      where: { active_driver_uid: driver.matricNumber },
      select: { terminal_id: true, status: true },
    }),
  ]);

  return {
    todayEarnings: todayEarningsAgg._sum.driver_share
      ? parseFloat(todayEarningsAgg._sum.driver_share.toString())
      : 0,
    todayRidesCount,
    availableBalance: driverWallet
      ? parseFloat(driverWallet.balance.toString())
      : 0,
    terminalStatus: terminal?.status ?? "OFFLINE",
    terminalId: terminal?.terminal_id ?? null,
  };
}

async function getDriverRides(userId: string, page: number = 1, limit: number = 20) {
  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true, role: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  const pageNum = Math.max(1, page);
  const limitNum = Math.min(100, Math.max(1, limit));
  const skip = (pageNum - 1) * limitNum;

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        driver_uid: driver.matricNumber,
        type: "RIDE",
      },
      orderBy: { synced_at: "desc" },
      skip,
      take: limitNum,
      include: {
        user: {
          select: {
            firstname: true,
            lastname: true,
            matricNumber: true,
          },
        },
      },
    }),
    prisma.transaction.count({
      where: {
        driver_uid: driver.matricNumber,
        type: "RIDE",
      },
    }),
  ]);

  const rides = transactions.map((tx) => ({
    id: tx.transaction_id,
    amount: tx.driver_share
      ? parseFloat(tx.driver_share.toString())
      : tx.fare
      ? parseFloat(tx.fare.toString())
      : parseFloat(tx.amount.toString()),
    studentMatric: tx.student_uid,
    studentName: tx.user ? `${tx.user.firstname} ${tx.user.lastname}`.trim() : tx.student_uid,
    terminalId: tx.terminal_id,
    status: "COMPLETED",
    createdAt: tx.synced_at,
    reference: tx.transaction_id,
  }));

  return {
    rides,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  };
}

export interface CreateWithdrawalParams {
  amount: number;
  bankName: string;
  accountNumber?: string;
  accountName?: string;
  remarks?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

const CTRANSIT_PAYOUT_FEE_RATIO = 0.04; // 4% C-Transit payout fee

async function createDriverWithdrawal(
  userId: string,
  params: CreateWithdrawalParams,
  dbClient: DbClient = prisma,
  payoutGateway: IPaymentGateway = paymentContainer
) {
  const { amount, bankName, accountNumber, accountName, remarks } = params;

  const grossAmount = Math.round(amount * 100) / 100;
  if (isNaN(grossAmount) || grossAmount <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  // C-Transit business rule: driver bears a 4% payout fee
  const ctransitFee = Math.round(grossAmount * CTRANSIT_PAYOUT_FEE_RATIO * 100) / 100;
  const netAmount = Math.round((grossAmount - ctransitFee) * 100) / 100;

  if (netAmount <= 0) {
    throw new Error("AMOUNT_TOO_LOW");
  }

  const driver = await dbClient.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      matricNumber: true,
      role: true,
      email: true,
      firstname: true,
      lastname: true,
      bankName: true,
      accountNumber: true,
    },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  const hasStoredBankDetails = !!(
    driver.bankName &&
    driver.bankName.trim() &&
    driver.accountNumber &&
    driver.accountNumber.trim()
  );

  const effectiveBankName = hasStoredBankDetails
    ? driver.bankName.trim()
    : bankName?.trim() || "";

  const effectiveAccountNumber = hasStoredBankDetails
    ? driver.accountNumber.trim()
    : accountNumber?.trim() || "";

  const effectiveAccountName =
    accountName?.trim() ||
    `${driver.firstname} ${driver.lastname}`.trim() ||
    "Driver Account";

  if (!effectiveBankName || !effectiveAccountNumber) {
    throw new Error("MISSING_BANK_DETAILS");
  }

  // Atomic reservation of gross amount from DriverWallet
  const withdrawal = await dbClient.$transaction(async (tx: DbClient) => {
    const wallet = await tx.driverWallet.findUnique({
      where: { driver_uid: driver.matricNumber },
    });

    if (!wallet) {
      throw new Error("WALLET_NOT_FOUND");
    }

    const currentBalance = parseFloat(wallet.balance.toString());
    if (currentBalance < grossAmount) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    // Atomic debit to driver balance — reserves the requested gross amount
    if (tx.driverWallet.updateMany) {
      const debitResult = await tx.driverWallet.updateMany({
        where: {
          driver_uid: driver.matricNumber,
          balance: { gte: grossAmount },
        },
        data: {
          balance: { decrement: grossAmount },
        },
      });

      if (debitResult.count === 0) {
        throw new Error("INSUFFICIENT_BALANCE");
      }
    } else {
      await tx.driverWallet.update({
        where: { driver_uid: driver.matricNumber },
        data: {
          balance: { decrement: grossAmount },
        },
      });
    }

    const reference = `WDR-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const record = await tx.driverWithdrawal.create({
      data: {
        driver_uid: driver.matricNumber,
        amount: grossAmount,
        fee: ctransitFee,
        net_amount: netAmount,
        bank_name: effectiveBankName,
        account_number: effectiveAccountNumber,
        account_name: effectiveAccountName,
        remarks: remarks?.trim() || null,
        reference,
        status: "PENDING",
      },
    });

    // If driver does not have stored bank details yet, persist them as verified details
    if (!hasStoredBankDetails) {
      await tx.user.update({
        where: { id: driver.id },
        data: {
          bankName: effectiveBankName,
          accountNumber: effectiveAccountNumber,
        },
      });
    }

    return record;
  });

  logger.info(
    {
      driverUid: driver.matricNumber,
      grossAmount,
      fee: ctransitFee,
      netAmount,
      reference: withdrawal.reference,
    },
    "driver.withdrawal_requested"
  );

  // Immediately initiate Kora bank payout
  if (dbClient?.driverWithdrawal?.findUnique) {
    await processWithdrawalPayout(withdrawal.id, dbClient, payoutGateway);
  }

  const updated = dbClient?.driverWithdrawal?.findUnique
    ? await dbClient.driverWithdrawal.findUnique({
        where: { id: withdrawal.id },
      })
    : null;

  return {
    id: updated?.id || withdrawal.id,
    amount: parseFloat((updated?.amount || withdrawal.amount).toString()),
    fee: updated?.fee ? parseFloat(updated.fee.toString()) : ctransitFee,
    netAmount: updated?.net_amount ? parseFloat(updated.net_amount.toString()) : netAmount,
    status: updated?.status || withdrawal.status,
    reference: updated?.reference || withdrawal.reference,
    koraReference: updated?.kora_reference || undefined,
  };
}

async function processWithdrawalPayout(
  withdrawalId: string,
  dbClient: DbClient = prisma,
  gateway: IPaymentGateway = paymentContainer
): Promise<{
  status: string;
  koraReference?: string;
  koraFee?: number;
  failureReason?: string;
}> {
  const withdrawal = await dbClient.driverWithdrawal.findUnique({
    where: { id: withdrawalId },
    include: { driver: true },
  });

  if (!withdrawal) {
    logger.warn({ withdrawalId }, "driver.payout_withdrawal_not_found");
    return { status: "NOT_FOUND" };
  }

  // Idempotency check: prevent duplicate payout initiation for the same withdrawal
  if (withdrawal.status !== "PENDING") {
    logger.warn(
      {
        withdrawalId,
        reference: withdrawal.reference,
        status: withdrawal.status,
      },
      "driver.payout_duplicate_initiation_prevented"
    );
    return {
      status: withdrawal.status,
      koraReference: withdrawal.kora_reference || undefined,
      koraFee: withdrawal.kora_fee
        ? parseFloat(withdrawal.kora_fee.toString())
        : undefined,
    };
  }

  // Transition lifecycle: PENDING -> PROCESSING
  await dbClient.driverWithdrawal.update({
    where: { id: withdrawalId },
    data: { status: "PROCESSING" },
  });

  if (!gateway || !gateway.initiatePayout) {
    logger.info(
      { withdrawalId, reference: withdrawal.reference },
      "driver.gateway_no_payout_support — retaining PROCESSING status"
    );
    return { status: "PROCESSING" };
  }

  const netAmount = withdrawal.net_amount
    ? parseFloat(withdrawal.net_amount.toString())
    : parseFloat(withdrawal.amount.toString());

  const payoutParams: PayoutParams = {
    reference: withdrawal.reference,
    amount: netAmount,
    destination: {
      type: "bank_account",
      amount: netAmount,
      currency: "NGN",
      narration: `C-Transit Driver Payout ${withdrawal.reference}`,
      bank_account: {
        bank: withdrawal.bank_name,
        account: withdrawal.account_number,
      },
    },
    customer: {
      name: withdrawal.account_name,
      email: withdrawal.driver?.email || `${withdrawal.driver_uid}@ctransit.me`,
    },
  };

  try {
    const res = await gateway.initiatePayout(payoutParams);

    if (res.status === "success") {
      await dbClient.driverWithdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: "SUCCESS",
          kora_reference: res.koraReference || null,
          kora_fee: res.fee !== undefined ? res.fee : null,
        },
      });

      sendNotification(
        withdrawal.driver_uid,
        "Withdrawal Successful",
        `Your withdrawal of ₦${netAmount.toLocaleString()} has been sent to your bank account.`
      ).catch(() => {});

      return {
        status: "SUCCESS",
        koraReference: res.koraReference,
        koraFee: res.fee,
      };
    }

    if (res.status === "failed") {
      // Rejection / failure -> Restore driver balance exactly once
      await dbClient.$transaction(async (tx: DbClient) => {
        const current = await tx.driverWithdrawal.findUnique({
          where: { id: withdrawalId },
        });

        if (!current || current.status === "SUCCESS" || current.status === "FAILED") {
          return;
        }

        // Restore reserved gross amount
        await tx.driverWallet.update({
          where: { driver_uid: current.driver_uid },
          data: { balance: { increment: current.amount } },
        });

        await tx.driverWithdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: "FAILED",
            failure_reason: res.message || "Payout rejected by payment gateway",
            kora_reference: res.koraReference || null,
            kora_fee: res.fee !== undefined ? res.fee : null,
          },
        });
      });

      sendNotification(
        withdrawal.driver_uid,
        "Withdrawal Failed",
        `Your withdrawal request could not be processed. Your wallet balance has been restored.`
      ).catch(() => {});

      return {
        status: "FAILED",
        failureReason: res.message,
        koraReference: res.koraReference,
        koraFee: res.fee,
      };
    }

    // PROCESSING, PENDING, or ambiguous_timeout
    await dbClient.driverWithdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: "PROCESSING",
        kora_reference: res.koraReference || null,
        kora_fee: res.fee !== undefined ? res.fee : null,
        remarks:
          res.status === "ambiguous_timeout"
            ? "Payout processing; pending webhook/query reconciliation"
            : withdrawal.remarks,
      },
    });

    return {
      status: "PROCESSING",
      koraReference: res.koraReference,
      koraFee: res.fee,
    };
  } catch (error) {
    logger.error(
      {
        withdrawalId,
        error: error instanceof Error ? error.message : String(error),
      },
      "driver.payout_unexpected_exception — retaining PROCESSING status"
    );
    return { status: "PROCESSING" };
  }
}

export interface PayoutWebhookParams {
  reference: string;
  koraReference?: string;
  event: string;
  status?: string;
  fee?: number;
  amount?: number;
  reason?: string;
}

async function handleDriverPayoutWebhook(
  params: PayoutWebhookParams,
  dbClient: DbClient = prisma
): Promise<{ success: boolean; message: string; withdrawalId?: string }> {
  const { reference, koraReference, event, status, fee, reason } = params;

  if (!reference && !koraReference) {
    return { success: false, message: "Missing reference" };
  }

  // Find withdrawal by C-Transit reference or Kora reference
  const withdrawal = await dbClient.driverWithdrawal.findFirst({
    where: {
      OR: [
        ...(reference ? [{ reference }] : []),
        ...(koraReference ? [{ kora_reference: koraReference }] : []),
      ],
    },
  });

  if (!withdrawal) {
    logger.warn({ reference, koraReference }, "driver.payout_webhook_not_found");
    return { success: false, message: "Withdrawal not found" };
  }

  // Idempotency: repeated webhooks must not change balances/status twice!
  if (withdrawal.status === "SUCCESS") {
    logger.info(
      { reference: withdrawal.reference },
      "driver.payout_webhook_already_success — idempotent skip"
    );
    return {
      success: true,
      message: "Withdrawal already marked SUCCESS",
      withdrawalId: withdrawal.id,
    };
  }

  if (withdrawal.status === "FAILED") {
    logger.info(
      { reference: withdrawal.reference },
      "driver.payout_webhook_already_failed — idempotent skip"
    );
    return {
      success: true,
      message: "Withdrawal already marked FAILED",
      withdrawalId: withdrawal.id,
    };
  }

  const isSuccess =
    event === "transfer.success" ||
    event === "payout.success" ||
    event === "disbursement.success" ||
    status === "success" ||
    status === "successful";

  const isFailed =
    event === "transfer.failed" ||
    event === "payout.failed" ||
    event === "disbursement.failed" ||
    status === "failed" ||
    status === "rejected";

  if (isSuccess) {
    await dbClient.$transaction(async (tx: DbClient) => {
      const current = await tx.driverWithdrawal.findUnique({
        where: { id: withdrawal.id },
      });

      if (!current || current.status === "SUCCESS" || current.status === "FAILED") {
        return;
      }

      await tx.driverWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: "SUCCESS",
          kora_reference: koraReference || current.kora_reference,
          kora_fee: fee !== undefined ? fee : current.kora_fee,
        },
      });
    });

    sendNotification(
      withdrawal.driver_uid,
      "Withdrawal Successful",
      `Your withdrawal has been successfully paid out to your bank account.`
    ).catch(() => {});

    logger.info(
      { reference: withdrawal.reference, driverUid: withdrawal.driver_uid },
      "driver.payout_webhook_success_finalized"
    );

    return {
      success: true,
      message: "Withdrawal finalized as SUCCESS",
      withdrawalId: withdrawal.id,
    };
  }

  if (isFailed) {
    await dbClient.$transaction(async (tx: DbClient) => {
      const current = await tx.driverWithdrawal.findUnique({
        where: { id: withdrawal.id },
      });

      // Crucial: successful payout CANNOT restore/refund balance!
      if (!current || current.status === "SUCCESS" || current.status === "FAILED") {
        return;
      }

      // Restore reserved gross balance exactly once
      await tx.driverWallet.update({
        where: { driver_uid: current.driver_uid },
        data: { balance: { increment: current.amount } },
      });

      await tx.driverWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: "FAILED",
          failure_reason: reason || "Transfer failed by payout provider",
          kora_reference: koraReference || current.kora_reference,
          kora_fee: fee !== undefined ? fee : current.kora_fee,
        },
      });
    });

    sendNotification(
      withdrawal.driver_uid,
      "Withdrawal Failed",
      `Your withdrawal could not be completed. Your wallet balance has been restored.`
    ).catch(() => {});

    logger.info(
      { reference: withdrawal.reference, driverUid: withdrawal.driver_uid, amount: withdrawal.amount },
      "driver.payout_webhook_failed_balance_restored"
    );

    return {
      success: true,
      message: "Withdrawal marked FAILED and balance restored",
      withdrawalId: withdrawal.id,
    };
  }

  return { success: true, message: "Unhandled webhook event" };
}

async function getDriverWithdrawals(userId: string, page: number = 1, limit: number = 20) {
  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { matricNumber: true, role: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  const pageNum = Math.max(1, page);
  const limitNum = Math.min(100, Math.max(1, limit));
  const skip = (pageNum - 1) * limitNum;

  const [records, total] = await Promise.all([
    prisma.driverWithdrawal.findMany({
      where: { driver_uid: driver.matricNumber },
      orderBy: { created_at: "desc" },
      skip,
      take: limitNum,
    }),
    prisma.driverWithdrawal.count({
      where: { driver_uid: driver.matricNumber },
    }),
  ]);

  const withdrawals = records.map((w) => ({
    id: w.id,
    amount: parseFloat(w.amount.toString()),
    fee: w.fee ? parseFloat(w.fee.toString()) : 0,
    netAmount: w.net_amount
      ? parseFloat(w.net_amount.toString())
      : parseFloat(w.amount.toString()),
    status: w.status,
    createdAt: w.created_at,
    reference: w.reference,
    remarks: w.remarks ?? "",
    koraReference: w.kora_reference ?? undefined,
  }));

  return {
    withdrawals,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  };
}

export interface LinkDriverCardParams {
  otp: string;
  cardUid?: string;
  driverId?: string;
}

async function linkDriverCard(userId: string, params: LinkDriverCardParams) {
  const { otp, cardUid, driverId } = params;

  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true, role: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  if (driverId) {
    if (driverId !== driver.id && driverId.toUpperCase() !== driver.matricNumber) {
      throw new Error("UNAUTHORIZED_DRIVER_ID");
    }
  }

  if (!otp || typeof otp !== "string" || !/^\d{6}$/.test(otp.trim())) {
    throw new Error("INVALID_OTP_FORMAT");
  }

  const cleanOtp = otp.trim();
  const otpRecord = await prisma.registrationOtp.findUnique({
    where: { otp: cleanOtp },
  });

  if (!otpRecord) {
    throw new Error("INVALID_OTP");
  }

  if (cardUid && otpRecord.card_uid.toUpperCase() !== cardUid.trim().toUpperCase()) {
    throw new Error("CARD_MISMATCH");
  }

  if (otpRecord.used) {
    const existing = await prisma.cardMapping.findUnique({
      where: { student_uid: driver.matricNumber },
    });
    if (existing && existing.card_uid === otpRecord.card_uid) {
      return {
        success: true,
        message: "Card already linked",
        cardUid: existing.card_uid,
        alreadyLinked: true,
      };
    }
    throw new Error("OTP_ALREADY_USED");
  }

  if (otpRecord.expires_at < new Date()) {
    throw new Error("OTP_EXPIRED");
  }

  // Atomically claim OTP and upsert card mapping within a single Prisma transaction
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.registrationOtp.updateMany({
      where: { otp: cleanOtp, used: false },
      data: { used: true },
    });

    if (consumed.count === 0) {
      // Check if this driver already linked this exact card (retry safety)
      const existing = await tx.cardMapping.findUnique({
        where: { student_uid: driver.matricNumber },
      });
      if (existing && existing.card_uid === otpRecord.card_uid) {
        return;
      }
      throw new Error("OTP_ALREADY_USED");
    }

    await tx.cardMapping.upsert({
      where: { card_uid: otpRecord.card_uid },
      update: { student_uid: driver.matricNumber },
      create: {
        card_uid: otpRecord.card_uid,
        student_uid: driver.matricNumber,
      },
    });
  });

  // Send in-app notification
  sendNotification(
    driver.matricNumber,
    "Card Linked Successfully 💳",
    "Your driver card has been successfully linked to your C-Transit account."
  ).catch(() => {});

  // Enqueue delta ADD WL to origin terminal
  try {
    const addWlCmd = buildDeltaCommand("ADD", "WL", otpRecord.card_uid);
    await enqueueRoute(otpRecord.terminal_id, addWlCmd);
  } catch (err) {
    logger.warn({ err }, "driver.card_link_enqueue_warning");
  }

  logger.info(
    { cardUid: otpRecord.card_uid, driverUid: driver.matricNumber },
    "driver.card_linked_successfully"
  );

  return {
    success: true,
    message: "Card linked successfully",
    cardUid: otpRecord.card_uid,
    driverId: driver.matricNumber,
  };
}

export {
  listDrivers,
  registerDriverByAgent,
  getDriverWallet,
  loginDriver,
  getDriverProfile,
  getDriverDashboard,
  getDriverRides,
  createDriverWithdrawal,
  processWithdrawalPayout,
  handleDriverPayoutWebhook,
  getDriverWithdrawals,
  linkDriverCard,
};
