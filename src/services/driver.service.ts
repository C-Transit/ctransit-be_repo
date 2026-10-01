"use strict";

import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "./ledger.service.js";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { issueRefreshToken } from "./token.service.js";
import { sendNotification } from "./notification.service.js";
import { terminalProvisioningService } from "./terminal-provisioning.service.js";
import { paymentContainer } from "../payments/payment.container.js";
import type {
  IPaymentGateway,
  PayoutParams,
} from "../payments/payment.interface.js";

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4
    ? `${"*".repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`
    : "****";
}

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
  const normUid = driverUid.trim().toUpperCase();
  const log = logger.child({ terminalId, driverUid: normUid });

  const driver = await prisma.user.findFirst({
    where: {
      matricNumber: normUid,
      role: "DRIVER",
    },
    select: { id: true, firstname: true, lastname: true, matricNumber: true },
  });

  if (!driver) {
    log.warn("driver.not_found_or_not_driver_role");
    return { success: false, message: "Driver not recognised." };
  }

  // Enforce single-terminal invariant: Clear driver association from any other
  // terminal where this driver was previously active.
  await prisma.terminal.updateMany({
    where: {
      active_driver_uid: driver.matricNumber,
      terminal_id: { not: terminalId },
    },
    data: { active_driver_uid: null },
  });

  // Assign driver to the current terminal
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

async function handleDriverLogout(terminalId?: string, driverUid?: string) {
  const normUid = driverUid ? driverUid.trim().toUpperCase() : undefined;
  const log = logger.child({ terminalId, driverUid: normUid });

  if (terminalId) {
    await prisma.terminal.updateMany({
      where: {
        terminal_id: terminalId,
        ...(normUid ? { active_driver_uid: normUid } : {}),
      },
      data: { active_driver_uid: null },
    });
  } else if (normUid) {
    await prisma.terminal.updateMany({
      where: { active_driver_uid: normUid },
      data: { active_driver_uid: null },
    });
  }

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
      balance: driver.driverWallet
        ? parseFloat(driver.driverWallet.balance.toString())
        : 0,
      total_earnings: driver.driverWallet
        ? parseFloat(driver.driverWallet.total_earnings.toString())
        : 0,
    },
    activeTerminal: terminalByDriver.get(driver.matricNumber) ?? null,
  }));
}

// ─────────────────────────────────────────────
// registerDriverByAgent
//
// Back to the default split: the agent only creates the bare driver account
// here — firstname, lastname, phone, a 4-digit PIN. Card linking and bank
// account verification are done afterwards, driver-side, with the agent
// simply logging into the driver's account (phone + the PIN just set) to
// help them through it — see linkDriverCard() and verifyAndSaveDriverBank().
//
// The driver's matricNumber is generated internally (DRV-XXXXXXXX) — agents
// never see or type it. The PIN doubles as both the app-login credential
// (User.password) and, once a card is linked, the terminal tap-in PIN —
// they're kept as the same secret for now (see linkDriverCard).
// ─────────────────────────────────────────────

export interface RegisterDriverData {
  firstname: string;
  lastname: string;
  phone: string;
  pin: string;
}

function generateDriverUid(): string {
  // 4 random bytes → 8 hex chars. Collision odds are negligible, but the
  // caller still retries on a P2002 hit against matricNumber, just in case.
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `DRV-${suffix}`;
}

async function registerDriverByAgent(data: RegisterDriverData) {
  const firstname = data.firstname?.trim();
  const lastname = data.lastname?.trim();
  const phone = data.phone?.trim();
  const pin = data.pin?.trim();

  if (!firstname || !lastname) {
    throw new Error("MISSING_NAME");
  }
  if (!phone || !/^\+?\d{7,15}$/.test(phone)) {
    throw new Error("INVALID_PHONE");
  }
  if (!pin || !/^\d{4}$/.test(pin)) {
    throw new Error("INVALID_PIN_FORMAT");
  }

  // Phone must be free before we go any further.
  const existingPhone = await prisma.user.findUnique({
    where: { phone },
    select: { id: true },
  });
  if (existingPhone) {
    throw new Error("PHONE_ALREADY_IN_USE");
  }

  const pinHash = await bcrypt.hash(pin, 10);

  const MAX_UID_ATTEMPTS = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_UID_ATTEMPTS; attempt++) {
    const matricNumber = generateDriverUid();

    try {
      const driver = await prisma.user.create({
        data: {
          firstname,
          lastname,
          email: "-",
          matricNumber,
          phone,
          password: pinHash,
          role: "DRIVER",
          isVerified: true,
          driverWallet: {
            create: { balance: 0, total_earnings: 0 },
          },
        },
        select: {
          id: true,
          firstname: true,
          lastname: true,
          phone: true,
          matricNumber: true,
          createdAt: true,
          driverWallet: {
            select: { balance: true, total_earnings: true },
          },
        },
      });

      logger.info(
        { matricNumber: driver.matricNumber },
        "driver.registered_by_agent"
      );

      return driver;
    } catch (error) {
      const prismaError = error as {
        code?: string;
        meta?: { target?: string[] | string };
      };
      const target = Array.isArray(prismaError.meta?.target)
        ? prismaError.meta.target.join(",")
        : prismaError.meta?.target || "";

      // Driver UID collision — vanishingly unlikely, but retry with a fresh one.
      if (prismaError.code === "P2002" && target.includes("matricNumber")) {
        lastError = error;
        continue;
      }

      if (prismaError.code === "P2002" && target.includes("phone")) {
        throw new Error("PHONE_ALREADY_IN_USE", { cause: error });
      }

      throw error;
    }
  }

  logger.error(
    { err: String(lastError) },
    "driver.uid_generation_exhausted_retries"
  );
  throw new Error("DRIVER_UID_GENERATION_FAILED");
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

// Pre-computed hash used in the dummy compare path when no driver matches
// the given phone. bcrypt.compare is constant-time regardless of match, but
// calling it at all — even against a fake row — is what prevents a phone
// number's existence from leaking through response-time differences. Same
// pattern as agent.service.ts's loginAgent.
const DRIVER_DUMMY_HASH =
  "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

async function loginDriver(phone: string, pin: string) {
  const trimmedPhone = phone.trim();
  const driver = await prisma.user.findFirst({
    where: { phone: trimmedPhone, role: "DRIVER" },
  });

  // Always run bcrypt — prevents timing-based phone-number enumeration.
  const validPin = await bcrypt.compare(
    pin,
    driver?.password ?? DRIVER_DUMMY_HASH
  );

  if (!driver || !validPin) {
    logger.warn({ phone: trimmedPhone }, "driver.login_invalid_credentials");
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
    select: {
      terminal_id: true,
      status: true,
      location: true,
      last_seen: true,
    },
  });

  const terminalInfo = terminal
    ? {
        id: terminal.terminal_id,
        name: terminal.terminal_id,
        status: terminal.status,
        location: terminal.location ?? null,
        lastSeen: terminal.last_seen ? terminal.last_seen.toISOString() : null,
      }
    : {
        id: null,
        name: "N/A",
        status: "N/A",
        location: null,
        lastSeen: null,
      };

  const profile = {
    id: driver.id,
    firstname: driver.firstname,
    lastname: driver.lastname,
    email: driver.email,
    matricNumber: driver.matricNumber,
    phone: driver.phone ?? null,
    role: driver.role,
    terminalId: terminal?.terminal_id ?? null,
    terminalStatus: terminal ? terminal.status : "N/A",
    terminal: terminalInfo,
    vehicleType: driver.vehicleType ?? null,
    vehiclePlate: driver.vehiclePlate ?? null,
    bankCode: driver.bankCode ?? null,
    bankName: driver.bankName ?? null,
    accountNumber: driver.accountNumber ?? null,
    accountName: driver.accountName ?? null,
    bankVerified: driver.bankVerified ?? false,
  };

  logger.info(
    { driverId: driver.id, matricNumber: driver.matricNumber },
    "driver.login_successful"
  );

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
    select: {
      terminal_id: true,
      status: true,
      location: true,
      last_seen: true,
    },
  });

  const terminalInfo = terminal
    ? {
        id: terminal.terminal_id,
        name: terminal.terminal_id,
        status: terminal.status,
        location: terminal.location ?? null,
        lastSeen: terminal.last_seen ? terminal.last_seen.toISOString() : null,
      }
    : {
        id: null,
        name: "N/A",
        status: "N/A",
        location: null,
        lastSeen: null,
      };

  return {
    id: driver.id,
    firstname: driver.firstname,
    lastname: driver.lastname,
    email: driver.email,
    matricNumber: driver.matricNumber,
    phone: driver.phone ?? null,
    role: driver.role,
    terminalId: terminal?.terminal_id ?? null,
    terminalStatus: terminal ? terminal.status : "N/A",
    terminal: terminalInfo,
    vehicleType: driver.vehicleType ?? null,
    vehiclePlate: driver.vehiclePlate ?? null,
    bankCode: driver.bankCode ?? null,
    bankName: driver.bankName ?? null,
    accountNumber: driver.accountNumber ?? null,
    accountName: driver.accountName ?? null,
    bankVerified: driver.bankVerified ?? false,
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
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  const [driverWallet, todayRidesCount, todayEarningsAgg, terminal] =
    await Promise.all([
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
        select: {
          terminal_id: true,
          status: true,
          location: true,
          last_seen: true,
        },
      }),
    ]);

  const terminalInfo = terminal
    ? {
        id: terminal.terminal_id,
        name: terminal.terminal_id,
        status: terminal.status,
        location: terminal.location ?? null,
        lastSeen: terminal.last_seen ? terminal.last_seen.toISOString() : null,
      }
    : {
        id: null,
        name: "N/A",
        status: "N/A",
        location: null,
        lastSeen: null,
      };

  return {
    todayEarnings: todayEarningsAgg._sum.driver_share
      ? parseFloat(todayEarningsAgg._sum.driver_share.toString())
      : 0,
    todayRidesCount,
    availableBalance: driverWallet
      ? parseFloat(driverWallet.balance.toString())
      : 0,
    terminalStatus: terminal ? terminal.status : "N/A",
    terminalId: terminal?.terminal_id ?? null,
    terminal: terminalInfo,
  };
}

async function getDriverRides(
  userId: string,
  page: number = 1,
  limit: number = 20
) {
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
    studentName: tx.user
      ? `${tx.user.firstname} ${tx.user.lastname}`.trim()
      : tx.student_uid,
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
  const { amount, bankName, remarks } = params;

  const grossAmount = Math.round(amount * 100) / 100;
  if (isNaN(grossAmount) || grossAmount <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  // C-Transit business rule: driver bears a 4% payout fee
  const ctransitFee =
    Math.round(grossAmount * CTRANSIT_PAYOUT_FEE_RATIO * 100) / 100;
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
      bankCode: true,
      bankName: true,
      accountNumber: true,
      accountName: true,
      bankVerified: true,
    },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  // Strictly enforce verified bank account details
  if (!driver.bankVerified || !driver.accountNumber || !driver.accountName) {
    throw new Error("BANK_NOT_VERIFIED");
  }

  const effectiveBankName =
    driver.bankName || bankName?.trim() || "Verified Bank";
  const effectiveAccountNumber = driver.accountNumber.trim();
  // Server-authoritative: Account name is strictly sourced from Kora resolution stored on user record
  const effectiveAccountName = driver.accountName.trim();

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

    const reference = `WDR-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase()}`;

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
    netAmount: updated?.net_amount
      ? parseFloat(updated.net_amount.toString())
      : netAmount,
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

        if (
          !current ||
          current.status === "SUCCESS" ||
          current.status === "FAILED"
        ) {
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
    logger.warn(
      { reference, koraReference },
      "driver.payout_webhook_not_found"
    );
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

      if (
        !current ||
        current.status === "SUCCESS" ||
        current.status === "FAILED"
      ) {
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
      if (
        !current ||
        current.status === "SUCCESS" ||
        current.status === "FAILED"
      ) {
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
      {
        reference: withdrawal.reference,
        driverUid: withdrawal.driver_uid,
        amount: withdrawal.amount,
      },
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

async function getDriverWithdrawals(
  userId: string,
  page: number = 1,
  limit: number = 20
) {
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
  pin: string;
  cardUid?: string;
  driverId?: string;
}

async function linkDriverCard(userId: string, params: LinkDriverCardParams) {
  const { otp, pin, cardUid, driverId } = params;

  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true, role: true, password: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  // The driver's login PIN and terminal PIN are the same secret by design —
  // re-confirm it here rather than accepting a new one. This is also what
  // gives us the plaintext PIN we need for the ADD:DR downlink below; it's
  // never stored anywhere, only hashed into DriverCardCredential.pin_hash.
  if (!pin || typeof pin !== "string" || !/^\d{4}$/.test(pin.trim())) {
    throw new Error("INVALID_PIN_FORMAT");
  }
  const cleanPin = pin.trim();
  const pinMatches = await bcrypt.compare(cleanPin, driver.password);
  if (!pinMatches) {
    throw new Error("INVALID_PIN");
  }

  // Security: authenticated user is identified exclusively from token userId.
  // If client supplies driverId, reject if mismatched.
  if (driverId) {
    if (
      driverId !== driver.id &&
      driverId.toUpperCase() !== driver.matricNumber
    ) {
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

  // Security: Card UID is strictly resolved from the terminal-generated OTP record.
  // If client provided cardUid, reject if mismatched.
  if (
    cardUid &&
    otpRecord.card_uid.toUpperCase() !== cardUid.trim().toUpperCase()
  ) {
    throw new Error("CARD_MISMATCH");
  }

  if (otpRecord.expires_at < new Date()) {
    throw new Error("OTP_EXPIRED");
  }

  if (!otpRecord.terminal_id) {
    throw new Error("MISSING_TERMINAL_CONTEXT");
  }

  // 1. Invariant check: ensure card is not already linked to another user
  const existingCardMapping = await prisma.cardMapping.findUnique({
    where: { card_uid: otpRecord.card_uid },
  });

  if (existingCardMapping) {
    if (existingCardMapping.student_uid === driver.matricNumber) {
      return {
        success: true,
        message: "Card already linked",
        cardUid: existingCardMapping.card_uid,
        alreadyLinked: true,
      };
    }
    throw new Error("CARD_ALREADY_LINKED");
  }

  // 2. Invariant check: ensure driver does not already have another active card linked
  const existingDriverMapping = await prisma.cardMapping.findUnique({
    where: { student_uid: driver.matricNumber },
  });

  if (
    existingDriverMapping &&
    existingDriverMapping.card_uid !== otpRecord.card_uid
  ) {
    throw new Error("DRIVER_ALREADY_HAS_CARD");
  }

  if (otpRecord.used) {
    throw new Error("OTP_ALREADY_USED");
  }

  // 3. Atomically consume OTP, create CardMapping, and store the terminal
  // credential (card UID + this same PIN, hashed) in one go.
  const pinHash = await bcrypt.hash(cleanPin, 10);
  try {
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.registrationOtp.updateMany({
        where: { otp: cleanOtp, used: false },
        data: { used: true },
      });

      if (consumed.count === 0) {
        const existing = await tx.cardMapping.findUnique({
          where: { student_uid: driver.matricNumber },
        });
        if (existing && existing.card_uid === otpRecord.card_uid) {
          return;
        }
        throw new Error("OTP_ALREADY_USED");
      }

      await tx.cardMapping.create({
        data: {
          card_uid: otpRecord.card_uid,
          student_uid: driver.matricNumber,
        },
      });

      await tx.driverCardCredential.upsert({
        where: { driver_uid: driver.matricNumber },
        update: { card_uid: otpRecord.card_uid, pin_hash: pinHash },
        create: {
          driver_uid: driver.matricNumber,
          card_uid: otpRecord.card_uid,
          pin_hash: pinHash,
        },
      });
    });
  } catch (error) {
    const prismaError = error as {
      code?: string;
      meta?: { target?: string[] | string };
    };
    const target = Array.isArray(prismaError.meta?.target)
      ? prismaError.meta.target.join(",")
      : prismaError.meta?.target || "";

    if (prismaError.code === "P2002") {
      if (target.includes("card_uid"))
        throw new Error("CARD_ALREADY_LINKED", { cause: error });
      if (target.includes("student_uid"))
        throw new Error("DRIVER_ALREADY_HAS_CARD", { cause: error });
    }

    throw error;
  }

  // 4. In-app notification to driver
  sendNotification(
    driver.matricNumber,
    "Driver Card Linked Successfully 💳",
    "Your physical driver card has been successfully linked to your C-Transit driver account."
  ).catch(() => {});

  // 5. Now that both the card UID and PIN are known, provision the
  // terminal's DR list: ADD:DR,{uid},{pin}. Best-effort — the DB is already
  // correct even if this hardware push fails, so we log rather than throw.
  try {
    await terminalProvisioningService.provisionCredential({
      cardUid: otpRecord.card_uid,
      pin: cleanPin,
      list: "DR",
      originTerminalId: otpRecord.terminal_id,
    });
  } catch (provisionErr) {
    logger.error(
      {
        driverUid: driver.matricNumber,
        cardUid: otpRecord.card_uid,
        err:
          provisionErr instanceof Error
            ? provisionErr.message
            : String(provisionErr),
      },
      "driver.terminal_provisioning_failed_after_card_link"
    );
  }

  logger.info(
    {
      cardUid: otpRecord.card_uid,
      driverUid: driver.matricNumber,
      terminalId: otpRecord.terminal_id,
    },
    "driver.card_linked_successfully"
  );

  return {
    success: true,
    message: "Driver card linked successfully",
    cardUid: otpRecord.card_uid,
    driverId: driver.matricNumber,
  };
}

export interface SetDriverPinParams {
  pin: string;
}

async function setDriverCardPin(userId: string, params: SetDriverPinParams) {
  const { pin } = params;

  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true, role: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  // 1. Verify driver has an active linked card
  const cardMap = await prisma.cardMapping.findUnique({
    where: { student_uid: driver.matricNumber },
  });

  if (!cardMap) {
    throw new Error("CARD_NOT_LINKED");
  }

  // 2. Validate PIN format (numeric, exactly 4 digits — matches the
  // firmware's ADD:DR,{uid},{pin} field and the driver's app-login PIN)
  if (!pin || typeof pin !== "string" || !/^\d{4}$/.test(pin.trim())) {
    throw new Error("INVALID_PIN_FORMAT");
  }

  const cleanPin = pin.trim();

  // 3. Hash PIN securely (cost 10) - NEVER plaintext, NEVER logged!
  // One PIN serves both the terminal tap-in and the driver's app login, so
  // the same hash is written to both DriverCardCredential.pin_hash and
  // User.password — keeping this endpoint in sync with app login too.
  const pinHash = await bcrypt.hash(cleanPin, 10);

  await prisma.$transaction([
    prisma.driverCardCredential.upsert({
      where: { driver_uid: driver.matricNumber },
      update: {
        card_uid: cardMap.card_uid,
        pin_hash: pinHash,
      },
      create: {
        driver_uid: driver.matricNumber,
        card_uid: cardMap.card_uid,
        pin_hash: pinHash,
      },
    }),
    prisma.user.update({
      where: { id: driver.id },
      data: { password: pinHash },
    }),
  ]);

  // 5. Provision the terminal's DR list — card UID + PIN together, per the
  // firmware contract (ADD:DR,{uid},{pin}).
  await terminalProvisioningService.provisionCredential({
    cardUid: cardMap.card_uid,
    pin: cleanPin,
    list: "DR",
  });

  // 6. In-app notification
  sendNotification(
    driver.matricNumber,
    "Terminal PIN Updated 🔒",
    "Your physical terminal login PIN has been successfully set."
  ).catch(() => {});

  logger.info(
    { driverUid: driver.matricNumber, cardUid: cardMap.card_uid },
    "driver.terminal_pin_set_successfully"
  );

  return {
    success: true,
    message: "Terminal PIN set successfully",
    cardUid: cardMap.card_uid,
  };
}

async function getDriverPinStatus(userId: string) {
  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true, role: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  const cardMap = await prisma.cardMapping.findUnique({
    where: { student_uid: driver.matricNumber },
  });

  let hasPin = false;
  if (prisma.driverCardCredential) {
    const cred = await prisma.driverCardCredential.findUnique({
      where: { driver_uid: driver.matricNumber },
    });
    hasPin = !!cred;
  }

  return {
    success: true,
    isCardLinked: !!cardMap,
    cardUid: cardMap?.card_uid || null,
    hasPin,
  };
}

export interface VerifyDriverBankParams {
  bankCode: string;
  accountNumber: string;
}

async function verifyAndSaveDriverBank(
  userId: string,
  params: VerifyDriverBankParams,
  payoutGateway: IPaymentGateway = paymentContainer
) {
  const { bankCode, accountNumber } = params;

  if (!bankCode || typeof bankCode !== "string" || !bankCode.trim()) {
    throw new Error("MISSING_BANK_CODE");
  }

  const cleanAccountNumber = accountNumber ? accountNumber.trim() : "";
  if (!cleanAccountNumber || !/^\d{10}$/.test(cleanAccountNumber)) {
    throw new Error("INVALID_ACCOUNT_NUMBER");
  }

  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true, role: true },
  });

  if (!driver || driver.role !== "DRIVER") {
    throw new Error("DRIVER_NOT_FOUND");
  }

  if (!payoutGateway.resolveBankAccount) {
    throw new Error("BANK_VERIFICATION_NOT_SUPPORTED");
  }

  // 1. Call Kora bank account resolution
  const resolved = await payoutGateway.resolveBankAccount(
    bankCode.trim(),
    cleanAccountNumber
  );

  // 2. Persist verified bank details to User model
  const updatedDriver = await prisma.user.update({
    where: { id: userId },
    data: {
      bankCode: resolved.bankCode,
      bankName: resolved.bankName || "Verified Bank",
      accountNumber: resolved.accountNumber,
      accountName: resolved.accountName,
      bankVerified: true,
    },
    select: {
      bankCode: true,
      bankName: true,
      accountNumber: true,
      accountName: true,
      bankVerified: true,
    },
  });

  logger.info(
    {
      driverId: userId,
      bankCode: resolved.bankCode,
      accountNumber: maskAccountNumber(resolved.accountNumber),
    },
    "driver.bank_account_verified_and_saved"
  );

  return {
    success: true,
    message: "Bank account verified successfully",
    data: updatedDriver,
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
  setDriverCardPin,
  getDriverPinStatus,
  verifyAndSaveDriverBank,
};
