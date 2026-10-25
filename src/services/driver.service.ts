import crypto from "crypto";
import { getRedisClient, cacheKeys } from "../config/redis.js";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import logger from "../config/logger.js";
import { issueRefreshToken, revokeAllRefreshTokens, signAccessToken } from "./token.service.js";
import { sendNotification } from "./notification.service.js";
import { terminalProvisioningService } from "./terminal-provisioning.service.js";
import { paymentContainer } from "../payments/payment.container.js";
import type { PayoutParams, BankInfo } from "../payments/payment.interface.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notify = (driverUid: string, title: string, body: string) =>
  sendNotification(driverUid, title, body).catch(() => {});
const num = (d: { toString(): string } | null | undefined) => (d ? parseFloat(d.toString()) : 0);

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4
    ? `${"*".repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`
    : "****";
}

// Real 60-char hash so a compare against an unknown phone costs the same as a real one.
const DRIVER_DUMMY_HASH = bcrypt.hashSync("dummy-pin", 10);
const PIN_MAX_FAILS = 5;
const PIN_LOCK_SECONDS = 15 * 60;

// PIN check with a lockout per key. Fails open if Redis is down.
async function checkPin(lockKey: string, pin: string, hash: string | undefined): Promise<boolean> {
  const redis = getRedisClient();
  const key = `driver:pin_fail:${lockKey}`;

  const fails = Number(await redis.get(key).catch(() => 0)) || 0;
  if (fails >= PIN_MAX_FAILS) throw new Error("TOO_MANY_ATTEMPTS");

  const ok = await bcrypt.compare(pin, hash ?? DRIVER_DUMMY_HASH);
  if (hash && ok) {
    redis.del(key).catch(() => {});
    return true;
  }
  redis.multi().incr(key).expire(key, PIN_LOCK_SECONDS).exec().catch(() => {});
  return false;
}

type TerminalRow = { terminal_id: string; status: string; location: string | null; last_seen: Date | null };

const TERMINAL_SELECT = { terminal_id: true, status: true, location: true, last_seen: true } as const;

const terminalInfo = (t: TerminalRow | null) =>
  t
    ? {
        id: t.terminal_id,
        name: t.terminal_id,
        status: t.status,
        location: t.location ?? null,
        lastSeen: t.last_seen ? t.last_seen.toISOString() : null,
      }
    : { id: null, name: "N/A", status: "N/A", location: null, lastSeen: null };

type DriverRow = {
  id: string;
  firstname: string;
  lastname: string;
  phone: string | null;
  role: string;
  vehicleType: string | null;
  vehiclePlate: string | null;
  bankCode: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountName: string | null;
  bankVerified: boolean;
};

// Driver-facing profile: no email and no matric number.
const toProfile = (d: DriverRow, t: TerminalRow | null) => ({
  id: d.id,
  firstname: d.firstname,
  lastname: d.lastname,
  phone: d.phone ?? null,
  role: d.role,
  terminalId: t?.terminal_id ?? null,
  terminalStatus: t ? t.status : "N/A",
  terminal: terminalInfo(t),
  vehicleType: d.vehicleType ?? null,
  vehiclePlate: d.vehiclePlate ?? null,
  bankCode: d.bankCode ?? null,
  bankName: d.bankName ?? null,
  accountNumber: d.accountNumber ?? null,
  accountName: d.accountName ?? null,
  bankVerified: d.bankVerified ?? false,
});

async function requireDriver<T extends object = { matricNumber: string }>(
  userId: string,
  select: Record<string, boolean> = { matricNumber: true }
) {
  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...select, role: true },
  });
  if (!driver || driver.role !== "DRIVER") throw new Error("DRIVER_NOT_FOUND");
  return driver as unknown as T & { role: string };
}

// ─────────────────────────────────────────────
// Terminal session (called from terminal flows)
// ─────────────────────────────────────────────

async function handleDriverLogin(terminalId: string, driverUid: string) {
  const normUid = driverUid.trim().toUpperCase();
  const log = logger.child({ terminalId, driverUid: normUid });

  const driver = await prisma.user.findFirst({
    where: { matricNumber: normUid, role: "DRIVER" },
    select: { firstname: true, lastname: true, matricNumber: true },
  });

  if (!driver) {
    log.warn("driver.not_found_or_not_driver_role");
    return { success: false, message: "Driver not recognised." };
  }

  // Single-terminal invariant: clear this driver from any other terminal.
  await prisma.terminal.updateMany({
    where: { active_driver_uid: driver.matricNumber, terminal_id: { not: terminalId } },
    data: { active_driver_uid: null },
  });
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
  const normUid = driverUid?.trim().toUpperCase();

  if (terminalId) {
    await prisma.terminal.updateMany({
      where: { terminal_id: terminalId, ...(normUid ? { active_driver_uid: normUid } : {}) },
      data: { active_driver_uid: null },
    });
  } else if (normUid) {
    await prisma.terminal.updateMany({
      where: { active_driver_uid: normUid },
      data: { active_driver_uid: null },
    });
  }

  logger.info({ terminalId, driverUid: normUid }, "driver.logged_out_of_terminal");
  return { success: true, message: "Driver logged out." };
}

// ─────────────────────────────────────────────
// Listing and registration
// ─────────────────────────────────────────────

async function listDrivers() {
  const [drivers, activeTerminals] = await Promise.all([
    prisma.user.findMany({
      where: { role: "DRIVER" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        phone: true,
        matricNumber: true,
        createdAt: true,
        driverWallet: { select: { balance: true, total_earnings: true } },
      },
    }),
    prisma.terminal.findMany({
      where: { active_driver_uid: { not: null } },
      select: { terminal_id: true, status: true, active_driver_uid: true },
    }),
  ]);

  const terminalByDriver = new Map(activeTerminals.map((t) => [t.active_driver_uid, t]));

  return drivers.map((driver) => ({
    ...driver,
    wallet: {
      balance: num(driver.driverWallet?.balance),
      total_earnings: num(driver.driverWallet?.total_earnings),
    },
    activeTerminal: terminalByDriver.get(driver.matricNumber) ?? null,
  }));
}

export interface RegisterDriverData {
  firstname: string;
  lastname: string;
  phone: string;
  pin: string;
}

// DRV-XXXXXXXX: internal id, never typed or shown to agents.
const generateDriverUid = () => `DRV-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

// An agent creates the bare account (name, phone, PIN). Card linking and bank
// verification happen afterwards, in the driver's own session.
async function registerDriverByAgent(data: RegisterDriverData) {
  const firstname = data.firstname?.trim();
  const lastname = data.lastname?.trim();
  const phone = data.phone?.trim();
  const pin = data.pin?.trim();

  if (!firstname || !lastname) throw new Error("MISSING_NAME");
  if (!phone || !/^\+?\d{7,15}$/.test(phone)) throw new Error("INVALID_PHONE");
  if (!pin || !/^\d{4}$/.test(pin)) throw new Error("INVALID_PIN_FORMAT");

  if (await prisma.user.findUnique({ where: { phone }, select: { id: true } })) {
    throw new Error("PHONE_ALREADY_IN_USE");
  }

  const pinHash = await bcrypt.hash(pin, 10);
  let lastError: unknown;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const matricNumber = generateDriverUid();

    try {
      const driver = await prisma.user.create({
        data: {
          firstname,
          lastname,
          // Placeholder: User.email is required and unique. Drivers have no real email.
          email: `${matricNumber.toLowerCase()}@drivers.ctransit.me`,
          matricNumber,
          phone,
          password: pinHash,
          role: "DRIVER",
          isVerified: true,
          driverWallet: { create: { balance: 0, total_earnings: 0 } },
        },
        select: {
          id: true,
          firstname: true,
          lastname: true,
          phone: true,
          matricNumber: true,
          createdAt: true,
          driverWallet: { select: { balance: true, total_earnings: true } },
        },
      });

      logger.info({ matricNumber: driver.matricNumber }, "driver.registered_by_agent");
      return driver;
    } catch (error) {
      const e = error as { code?: string; meta?: { target?: string[] | string } };
      const target = Array.isArray(e.meta?.target) ? e.meta.target.join(",") : e.meta?.target || "";

      if (e.code === "P2002" && target.includes("matricNumber")) {
        lastError = error;
        continue; // UID collision: retry with a fresh one
      }
      if (e.code === "P2002" && target.includes("phone")) {
        throw new Error("PHONE_ALREADY_IN_USE", { cause: error });
      }
      throw error;
    }
  }

  logger.error({ err: String(lastError) }, "driver.uid_generation_exhausted_retries");
  throw new Error("DRIVER_UID_GENERATION_FAILED");
}

// ─────────────────────────────────────────────
// Auth and profile
// ─────────────────────────────────────────────

async function loginDriver(phone: string, pin: string) {
  const trimmedPhone = phone.trim();
  const driver = await prisma.user.findFirst({ where: { phone: trimmedPhone, role: "DRIVER" } });

  // Always runs bcrypt (against a dummy hash when unknown) and counts failures per phone.
  const validPin = await checkPin(`login:${trimmedPhone}`, pin, driver?.password);
  if (!driver || !validPin) {
    logger.warn({ phone: trimmedPhone }, "driver.login_invalid_credentials");
    throw new Error("INVALID_CREDENTIALS");
  }

  const accessToken = signAccessToken({ userId: driver.id, role: "DRIVER", email: driver.email });
  const refreshToken = await issueRefreshToken({
    userId: driver.id,
    role: driver.role,
    email: driver.email,
  });

  const terminal = await prisma.terminal.findFirst({
    where: { active_driver_uid: driver.matricNumber },
    select: TERMINAL_SELECT,
  });

  logger.info({ driverId: driver.id }, "driver.login_successful");
  return { accessToken, refreshToken, driver: toProfile(driver, terminal) };
}

async function getDriverProfile(userId: string) {
  const driver = await prisma.user.findUnique({ where: { id: userId } });
  if (!driver || driver.role !== "DRIVER") throw new Error("DRIVER_NOT_FOUND");

  const terminal = await prisma.terminal.findFirst({
    where: { active_driver_uid: driver.matricNumber },
    select: TERMINAL_SELECT,
  });
  return toProfile(driver, terminal);
}

async function getDriverWallet(driverUid: string) {
  const uid = driverUid.toUpperCase();
  const wallet = await prisma.driverWallet.findUnique({ where: { driver_uid: uid } });
  return {
    driver_uid: uid,
    balance: num(wallet?.balance),
    total_earnings: num(wallet?.total_earnings),
  };
}

async function getDriverDashboard(userId: string) {
  const driver = await requireDriver(userId);

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayRides = { driver_uid: driver.matricNumber, type: "RIDE" as const, synced_at: { gte: startOfToday } };

  const [wallet, todayRidesCount, todayEarnings, terminal] = await Promise.all([
    prisma.driverWallet.findUnique({ where: { driver_uid: driver.matricNumber }, select: { balance: true } }),
    prisma.transaction.count({ where: todayRides }),
    prisma.transaction.aggregate({ where: todayRides, _sum: { driver_share: true } }),
    prisma.terminal.findFirst({ where: { active_driver_uid: driver.matricNumber }, select: TERMINAL_SELECT }),
  ]);

  return {
    todayEarnings: num(todayEarnings._sum.driver_share),
    todayRidesCount,
    availableBalance: num(wallet?.balance),
    terminalStatus: terminal ? terminal.status : "N/A",
    terminalId: terminal?.terminal_id ?? null,
    terminal: terminalInfo(terminal),
  };
}

async function getDriverRides(userId: string, page = 1, limit = 20) {
  const driver = await requireDriver(userId);

  const pageNum = Math.max(1, page);
  const limitNum = Math.min(100, Math.max(1, limit));
  const where = { driver_uid: driver.matricNumber, type: "RIDE" as const };

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { synced_at: "desc" },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      include: { user: { select: { firstname: true, lastname: true, matricNumber: true } } },
    }),
    prisma.transaction.count({ where }),
  ]);

  const rides = transactions.map((tx) => ({
    id: tx.transaction_id,
    amount: num(tx.driver_share ?? tx.fare ?? tx.amount),
    studentMatric: tx.student_uid,
    studentName: tx.user ? `${tx.user.firstname} ${tx.user.lastname}`.trim() : tx.student_uid,
    terminalId: tx.terminal_id,
    status: "COMPLETED",
    createdAt: tx.synced_at,
    reference: tx.transaction_id,
  }));

  return {
    rides,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  };
}

// ─────────────────────────────────────────────
// Banks
// ─────────────────────────────────────────────

const BANK_CACHE_MS = 24 * 60 * 60 * 1000;
let bankCache: { at: number; banks: BankInfo[] } | null = null;

// Provider bank list (name + the provider's own code), cached 24h; serves stale if the provider is down.
async function getBanks(): Promise<BankInfo[]> {
  if (bankCache && Date.now() - bankCache.at < BANK_CACHE_MS) return bankCache.banks;

  const listBanks = paymentContainer.listBanks?.bind(paymentContainer);
  if (!listBanks) throw new Error("BANK_LIST_NOT_SUPPORTED");

  try {
    const banks = await listBanks();
    if (banks.length === 0) throw new Error("EMPTY_BANK_LIST");
    bankCache = { at: Date.now(), banks };
    return banks;
  } catch (err) {
    if (bankCache) {
      logger.warn({ err: errText(err) }, "driver.bank_list_stale_served");
      return bankCache.banks;
    }
    throw err;
  }
}

export interface VerifyDriverBankParams {
  bankCode: string;
  accountNumber: string;
  pin: string;
}

export interface ResolveDriverBankParams {
  bankCode: string;
  accountNumber: string;
}

export interface ResolvedDriverBank {
  accountName: string;
  accountNumber: string;
  bankCode: string;
  bankName: string;
}

// Read-only lookup shared by the preview endpoint (no PIN, nothing saved) and by
// verifyAndSaveDriverBank (PIN required, persists the payout destination).
async function resolveDriverBankAccount(
  params: ResolveDriverBankParams
): Promise<ResolvedDriverBank> {
  const accountNumber = params.accountNumber?.trim() ?? "";
  if (!/^\d{10}$/.test(accountNumber)) throw new Error("INVALID_ACCOUNT_NUMBER");

  const bank = (await getBanks()).find((b) => b.code === params.bankCode?.trim());
  if (!bank) throw new Error("INVALID_BANK_CODE");

  const resolveBankAccount = paymentContainer.resolveBankAccount?.bind(paymentContainer);
  if (!resolveBankAccount) throw new Error("BANK_VERIFICATION_NOT_SUPPORTED");
  const resolved = await resolveBankAccount(bank.code, accountNumber);

  return {
    accountName: resolved.accountName,
    accountNumber: resolved.accountNumber || accountNumber,
    bankCode: bank.code,
    bankName: resolved.bankName || bank.name,
  };
}

// The driver picks a bank from the dropdown and types only the account number.
// Bank name/code come from the provider list, the account name from provider resolution,
// and changing the payout destination requires the driver's own PIN.
async function verifyAndSaveDriverBank(userId: string, params: VerifyDriverBankParams) {
  const accountNumber = params.accountNumber?.trim() ?? "";
  if (!/^\d{10}$/.test(accountNumber)) throw new Error("INVALID_ACCOUNT_NUMBER");

  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, password: true },
  });
  if (!driver || driver.role !== "DRIVER") throw new Error("DRIVER_NOT_FOUND");

  if (!(await checkPin(`bank:${driver.id}`, params.pin ?? "", driver.password))) {
    throw new Error("INVALID_PIN");
  }

  const resolved = await resolveDriverBankAccount({
    bankCode: params.bankCode,
    accountNumber,
  });

  const data = await prisma.user.update({
    where: { id: driver.id },
    data: {
      bankCode: resolved.bankCode,
      bankName: resolved.bankName,
      accountNumber: resolved.accountNumber,
      accountName: resolved.accountName,
      bankVerified: true,
    },
    select: { bankCode: true, bankName: true, accountNumber: true, accountName: true, bankVerified: true },
  });

  logger.warn(
    { driverId: driver.id, bankCode: resolved.bankCode, accountNumber: maskAccountNumber(accountNumber) },
    "driver.bank_account_changed"
  );
  return { success: true, message: "Bank account verified successfully", data };
}

// ─────────────────────────────────────────────
// Withdrawals
// ─────────────────────────────────────────────

export interface CreateWithdrawalParams {
  amount: number;
  remarks?: string;
  pin: string;
}

const CTRANSIT_PAYOUT_FEE_RATIO = 0.04; // the driver bears a 4% payout fee

// PENDING/PROCESSING -> SUCCESS. Returns false if it was already finalized.
async function markWithdrawalSuccess(id: string, koraReference?: string, fee?: number): Promise<boolean> {
  const r = await prisma.driverWithdrawal.updateMany({
    where: { id, status: { in: ["PENDING", "PROCESSING"] } },
    data: {
      status: "SUCCESS",
      ...(koraReference ? { kora_reference: koraReference } : {}),
      ...(fee !== undefined ? { kora_fee: fee } : {}),
    },
  });
  return r.count > 0;
}

// PENDING/PROCESSING -> FAILED and refund the reserved gross amount, exactly once.
async function failWithdrawalAndRefund(
  id: string,
  d: { reason: string; koraReference?: string; fee?: number }
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.driverWithdrawal.updateMany({
      where: { id, status: { in: ["PENDING", "PROCESSING"] } },
      data: {
        status: "FAILED",
        failure_reason: d.reason.slice(0, 255), // column is VarChar(255)
        ...(d.koraReference ? { kora_reference: d.koraReference } : {}),
        ...(d.fee !== undefined ? { kora_fee: d.fee } : {}),
      },
    });
    if (claimed.count === 0) return false;

    const w = await tx.driverWithdrawal.findUniqueOrThrow({
      where: { id },
      select: { driver_uid: true, amount: true },
    });
    await tx.driverWallet.update({
      where: { driver_uid: w.driver_uid },
      data: { balance: { increment: w.amount } },
    });
    return true;
  });
}

async function createDriverWithdrawal(userId: string, params: CreateWithdrawalParams) {
  const gross = Math.round(params.amount * 100) / 100;
  if (!Number.isFinite(gross) || gross <= 0) throw new Error("INVALID_AMOUNT");

  const fee = Math.round(gross * CTRANSIT_PAYOUT_FEE_RATIO * 100) / 100;
  const net = Math.round((gross - fee) * 100) / 100;
  if (net <= 0) throw new Error("AMOUNT_TOO_LOW");

  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      matricNumber: true,
      role: true,
      password: true,
      bankCode: true,
      bankName: true,
      accountNumber: true,
      accountName: true,
      bankVerified: true,
    },
  });
  if (!driver || driver.role !== "DRIVER") throw new Error("DRIVER_NOT_FOUND");

  const pin = params.pin?.trim() ?? "";
  if (!/^\d{4}$/.test(pin)) throw new Error("INVALID_PIN_FORMAT");
  if (!(await checkPin(`withdraw:${driver.id}`, pin, driver.password))) {
    throw new Error("INVALID_PIN");
  }

  if (!driver.bankVerified || !driver.bankCode || !driver.accountNumber || !driver.accountName) {
    throw new Error("BANK_NOT_VERIFIED");
  }

  const reference = `WDR-${crypto.randomUUID()}`;

  // Reserve the gross amount and record the withdrawal in one transaction.
  const withdrawal = await prisma.$transaction(async (tx) => {
    const debited = await tx.driverWallet.updateMany({
      where: { driver_uid: driver.matricNumber, balance: { gte: gross } },
      data: { balance: { decrement: gross } },
    });
    if (debited.count === 0) {
      const wallet = await tx.driverWallet.findUnique({
        where: { driver_uid: driver.matricNumber },
        select: { driver_uid: true },
      });
      throw new Error(wallet ? "INSUFFICIENT_BALANCE" : "WALLET_NOT_FOUND");
    }
    return tx.driverWithdrawal.create({
      data: {
        driver_uid: driver.matricNumber,
        amount: gross,
        fee,
        net_amount: net,
        bank_name: driver.bankName ?? "Verified Bank",
        account_number: driver.accountNumber!.trim(),
        account_name: driver.accountName!.trim(), // always the provider-resolved name
        remarks: params.remarks?.trim() || null,
        reference,
        status: "PENDING",
      },
    });
  });

  logger.info({ driverUid: driver.matricNumber, gross, fee, net, reference }, "driver.withdrawal_requested");

  const result = await processWithdrawalPayout(withdrawal.id);

  return {
    id: withdrawal.id,
    amount: gross,
    fee,
    netAmount: net,
    status: result.status,
    reference,
    koraReference: result.koraReference,
  };
}

async function processWithdrawalPayout(withdrawalId: string): Promise<{
  status: string;
  koraReference?: string;
  koraFee?: number;
  failureReason?: string;
}> {
  // Claim PENDING -> PROCESSING exactly once, so a payout can never be initiated twice.
  const claimed = await prisma.driverWithdrawal.updateMany({
    where: { id: withdrawalId, status: "PENDING" },
    data: { status: "PROCESSING" },
  });

  const withdrawal = await prisma.driverWithdrawal.findUnique({
    where: { id: withdrawalId },
    include: { driver: { select: { id: true, bankCode: true } } },
  });
  if (!withdrawal) return { status: "NOT_FOUND" };

  if (claimed.count === 0) {
    logger.warn({ withdrawalId, status: withdrawal.status }, "driver.payout_duplicate_initiation_prevented");
    return { status: withdrawal.status, koraReference: withdrawal.kora_reference ?? undefined };
  }

  const bankCode = withdrawal.driver.bankCode;
  if (!bankCode) {
    await failWithdrawalAndRefund(withdrawalId, { reason: "Missing bank code on driver record" });
    return { status: "FAILED", failureReason: "Missing bank code" };
  }

  const initiatePayout = paymentContainer.initiatePayout?.bind(paymentContainer);
  if (!initiatePayout) {
    logger.warn({ withdrawalId }, "driver.gateway_no_payout_support — retaining PROCESSING");
    return { status: "PROCESSING" };
  }

  const net = (withdrawal.net_amount ?? withdrawal.amount).toNumber();
  const payoutParams: PayoutParams = {
    reference: withdrawal.reference,
    amount: net,
    destination: {
      type: "bank_account",
      amount: net,
      currency: "NGN",
      narration: `C-Transit Driver Payout ${withdrawal.reference}`,
      bank_account: { bank: bankCode, account: withdrawal.account_number }, // bank CODE, not name
    },
    // Drivers have no real email; the provider only needs a well-formed address.
    customer: { name: withdrawal.account_name, email: `${withdrawal.driver.id}@drivers.ctransit.me` },
  };

  try {
    const res = await initiatePayout(payoutParams);

    if (res.status === "success") {
      await markWithdrawalSuccess(withdrawalId, res.koraReference, res.fee);
      notify(withdrawal.driver_uid, "Withdrawal Successful", `Your withdrawal of ₦${net.toLocaleString()} has been sent to your bank account.`);
      return { status: "SUCCESS", koraReference: res.koraReference, koraFee: res.fee };
    }

    if (res.status === "failed") {
      await failWithdrawalAndRefund(withdrawalId, {
        reason: res.message || "Payout rejected by payment gateway",
        koraReference: res.koraReference,
        fee: res.fee,
      });
      notify(withdrawal.driver_uid, "Withdrawal Failed", "Your withdrawal request could not be processed. Your wallet balance has been restored.");
      return { status: "FAILED", failureReason: res.message, koraReference: res.koraReference, koraFee: res.fee };
    }

    // processing / pending / ambiguous_timeout: the webhook (or reconciliation) decides.
    await prisma.driverWithdrawal.updateMany({
      where: { id: withdrawalId, status: "PROCESSING" },
      data: {
        ...(res.koraReference ? { kora_reference: res.koraReference } : {}),
        ...(res.fee !== undefined ? { kora_fee: res.fee } : {}),
        ...(res.status === "ambiguous_timeout"
          ? { remarks: "Payout processing; pending webhook/query reconciliation" }
          : {}),
      },
    });
    return { status: "PROCESSING", koraReference: res.koraReference, koraFee: res.fee };
  } catch (error) {
    // Never refund on an unknown outcome: the money may already have left.
    logger.error({ withdrawalId, error: errText(error) }, "driver.payout_unexpected_exception — retaining PROCESSING");
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
  params: PayoutWebhookParams
): Promise<{ success: boolean; message: string; withdrawalId?: string }> {
  const { reference, koraReference, event, fee, reason } = params;
  if (!reference && !koraReference) return { success: false, message: "Missing reference" };

  const withdrawal = await prisma.driverWithdrawal.findFirst({
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

  const succeeded = event === "transfer.success";
  const failed = event === "transfer.failed";
  const id = withdrawal.id;

  if (withdrawal.status === "SUCCESS" || withdrawal.status === "FAILED") {
    if ((withdrawal.status === "FAILED" && succeeded) || (withdrawal.status === "SUCCESS" && failed)) {
      logger.error(
        { reference: withdrawal.reference, status: withdrawal.status, event },
        "driver.payout_webhook_conflicts_with_final_state — manual review"
      );
    }
    return { success: true, message: `Withdrawal already marked ${withdrawal.status}`, withdrawalId: id };
  }

  if (succeeded) {
    if (await markWithdrawalSuccess(id, koraReference, fee)) {
      notify(withdrawal.driver_uid, "Withdrawal Successful", "Your withdrawal has been successfully paid out to your bank account.");
      logger.info({ reference: withdrawal.reference }, "driver.payout_webhook_success_finalized");
    }
    return { success: true, message: "Withdrawal finalized as SUCCESS", withdrawalId: id };
  }

  if (failed) {
    const refunded = await failWithdrawalAndRefund(id, {
      reason: reason || "Transfer failed by payout provider",
      koraReference,
      fee,
    });
    if (refunded) {
      notify(withdrawal.driver_uid, "Withdrawal Failed", "Your withdrawal could not be completed. Your wallet balance has been restored.");
      logger.info({ reference: withdrawal.reference, amount: withdrawal.amount.toString() }, "driver.payout_webhook_failed_balance_restored");
    }
    return { success: true, message: "Withdrawal marked FAILED and balance restored", withdrawalId: id };
  }

  return { success: true, message: "Unhandled webhook event" };
}

// Resolves PENDING/PROCESSING withdrawals older than N minutes by asking the provider.
// Same atomic claims as the webhook, so it is safe to run twice or alongside one.
async function reconcileStuckWithdrawals(olderThanMinutes = 15) {
  const verifyPayout = paymentContainer.verifyPayout?.bind(paymentContainer);
  if (!verifyPayout) return { checked: 0, success: 0, failed: 0, unresolved: 0 };

  const stuck = await prisma.driverWithdrawal.findMany({
    where: {
      status: { in: ["PENDING", "PROCESSING"] },
      updated_at: { lt: new Date(Date.now() - olderThanMinutes * 60_000) },
    },
    select: { id: true, reference: true, status: true },
    take: 50,
  });

  const summary = { checked: stuck.length, success: 0, failed: 0, unresolved: 0 };

  for (const w of stuck) {
    const q = await verifyPayout(w.reference);

    if (q.status === "success") {
      if (await markWithdrawalSuccess(w.id, q.koraReference, q.fee)) summary.success++;
    } else if (q.status === "failed" || (q.status === "not_found" && w.status === "PENDING")) {
      // not_found on a PENDING row means the request never reached the provider.
      const reason = q.status === "failed" ? q.message || "Payout failed (reconciled)" : "Payout never reached provider";
      if (await failWithdrawalAndRefund(w.id, { reason, koraReference: q.koraReference, fee: q.fee })) summary.failed++;
    } else {
      summary.unresolved++;
      logger.warn({ reference: w.reference, status: q.status }, "driver.reconcile_unresolved");
    }
  }

  logger.info(summary, "driver.reconcile_complete");
  return summary;
}

async function getDriverWithdrawals(userId: string, page = 1, limit = 20) {
  const driver = await requireDriver(userId);

  const pageNum = Math.max(1, page);
  const limitNum = Math.min(100, Math.max(1, limit));
  const where = { driver_uid: driver.matricNumber };

  const [records, total] = await Promise.all([
    prisma.driverWithdrawal.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    }),
    prisma.driverWithdrawal.count({ where }),
  ]);

  const withdrawals = records.map((w) => ({
    id: w.id,
    amount: num(w.amount),
    fee: num(w.fee),
    netAmount: num(w.net_amount ?? w.amount),
    status: w.status,
    createdAt: w.created_at,
    reference: w.reference,
    remarks: w.remarks ?? "",
    koraReference: w.kora_reference ?? undefined,
  }));

  return {
    withdrawals,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  };
}

// ─────────────────────────────────────────────
// Card and terminal PIN
// ─────────────────────────────────────────────

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
  if (!driver || driver.role !== "DRIVER") throw new Error("DRIVER_NOT_FOUND");

  // The login PIN and terminal PIN are one secret: re-confirm it, and keep the plaintext
  // only long enough for the ADD:DR downlink (stored solely as a hash).
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin.trim())) throw new Error("INVALID_PIN_FORMAT");
  const cleanPin = pin.trim();
  if (!(await checkPin(`link:${driver.id}`, cleanPin, driver.password))) throw new Error("INVALID_PIN");

  // The driver is identified only by the token. A mismatched client-supplied id is rejected.
  if (driverId && driverId !== driver.id && driverId.toUpperCase() !== driver.matricNumber) {
    throw new Error("UNAUTHORIZED_DRIVER_ID");
  }

  if (typeof otp !== "string" || !/^\d{6}$/.test(otp.trim())) throw new Error("INVALID_OTP_FORMAT");
  const cleanOtp = otp.trim();

  const otpRecord = await prisma.registrationOtp.findUnique({ where: { otp: cleanOtp } });
  if (!otpRecord) throw new Error("INVALID_OTP");

  // The card UID comes only from the terminal-generated OTP record.
  if (cardUid && otpRecord.card_uid.toUpperCase() !== cardUid.trim().toUpperCase()) {
    throw new Error("CARD_MISMATCH");
  }
  if (otpRecord.expires_at < new Date()) throw new Error("OTP_EXPIRED");
  if (!otpRecord.terminal_id) throw new Error("MISSING_TERMINAL_CONTEXT");

  const [cardOwner, driverCard] = await Promise.all([
    prisma.cardMapping.findUnique({ where: { card_uid: otpRecord.card_uid } }),
    prisma.cardMapping.findUnique({ where: { student_uid: driver.matricNumber } }),
  ]);

  if (cardOwner) {
    if (cardOwner.student_uid === driver.matricNumber) {
      return { success: true, message: "Card already linked", cardUid: cardOwner.card_uid, alreadyLinked: true };
    }
    throw new Error("CARD_ALREADY_LINKED");
  }
  if (driverCard && driverCard.card_uid !== otpRecord.card_uid) throw new Error("DRIVER_ALREADY_HAS_CARD");
  if (otpRecord.used) throw new Error("OTP_ALREADY_USED");

  // Consume the OTP, map the card and store the terminal credential in one transaction.
  const pinHash = await bcrypt.hash(cleanPin, 10);
  try {
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.registrationOtp.updateMany({
        where: { otp: cleanOtp, used: false },
        data: { used: true },
      });

      if (consumed.count === 0) {
        const existing = await tx.cardMapping.findUnique({ where: { student_uid: driver.matricNumber } });
        if (existing?.card_uid === otpRecord.card_uid) return;
        throw new Error("OTP_ALREADY_USED");
      }

      await tx.cardMapping.create({
        data: { card_uid: otpRecord.card_uid, student_uid: driver.matricNumber },
      });
      await tx.driverCardCredential.upsert({
        where: { driver_uid: driver.matricNumber },
        update: { card_uid: otpRecord.card_uid, pin_hash: pinHash },
        create: { driver_uid: driver.matricNumber, card_uid: otpRecord.card_uid, pin_hash: pinHash },
      });
    });
  } catch (error) {
    const e = error as { code?: string; meta?: { target?: string[] | string } };
    const target = Array.isArray(e.meta?.target) ? e.meta.target.join(",") : e.meta?.target || "";

    if (e.code === "P2002") {
      if (target.includes("card_uid")) throw new Error("CARD_ALREADY_LINKED", { cause: error });
      if (target.includes("student_uid")) throw new Error("DRIVER_ALREADY_HAS_CARD", { cause: error });
    }
    throw error;
  }

  notify(
    driver.matricNumber,
    "Driver Card Linked Successfully 💳",
    "Your physical driver card has been successfully linked to your C-Transit driver account."
  );

  // Push ADD:DR,{uid},{pin} to the terminal. Best-effort: the DB is already correct.
  try {
    await terminalProvisioningService.provisionCredential({
      cardUid: otpRecord.card_uid,
      pin: cleanPin,
      list: "DR",
      originTerminalId: otpRecord.terminal_id,
    });
  } catch (err) {
    logger.error(
      { driverUid: driver.matricNumber, err: errText(err) },
      "driver.terminal_provisioning_failed_after_card_link"
    );
  }

  logger.info(
    { driverUid: driver.matricNumber, terminalId: otpRecord.terminal_id },
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
  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true, role: true },
  });
  if (!driver || driver.role !== "DRIVER") throw new Error("DRIVER_NOT_FOUND");

  const cardMap = await prisma.cardMapping.findUnique({ where: { student_uid: driver.matricNumber } });
  if (!cardMap) throw new Error("CARD_NOT_LINKED");

  // Exactly 4 digits: matches the firmware's ADD:DR field and the app-login PIN.
  const pin = params.pin;
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin.trim())) throw new Error("INVALID_PIN_FORMAT");
  const cleanPin = pin.trim();

  // One PIN serves terminal tap-in and app login, so the same hash goes to both.
  const pinHash = await bcrypt.hash(cleanPin, 10);
  await prisma.$transaction([
    prisma.driverCardCredential.upsert({
      where: { driver_uid: driver.matricNumber },
      update: { card_uid: cardMap.card_uid, pin_hash: pinHash },
      create: { driver_uid: driver.matricNumber, card_uid: cardMap.card_uid, pin_hash: pinHash },
    }),
    prisma.user.update({ where: { id: driver.id }, data: { password: pinHash } }),
  ]);

  // A changed PIN must not leave old sessions refreshable.
  await revokeAllRefreshTokens(driver.id);

  await terminalProvisioningService.provisionCredential({
    cardUid: cardMap.card_uid,
    pin: cleanPin,
    list: "DR",
  });

  notify(driver.matricNumber, "Terminal PIN Updated 🔒", "Your physical terminal login PIN has been successfully set.");
  logger.info({ driverUid: driver.matricNumber }, "driver.terminal_pin_set_successfully");

  return { success: true, message: "Terminal PIN set successfully", cardUid: cardMap.card_uid };
}

async function getDriverPinStatus(userId: string) {
  const driver = await requireDriver(userId);

  const [cardMap, credential] = await Promise.all([
    prisma.cardMapping.findUnique({ where: { student_uid: driver.matricNumber } }),
    prisma.driverCardCredential.findUnique({ where: { driver_uid: driver.matricNumber } }),
  ]);

  return {
    success: true,
    isCardLinked: !!cardMap,
    cardUid: cardMap?.card_uid || null,
    hasPin: !!credential,
  };
}

async function unlinkDriverCard(userId: string, pin: string) {
  const driver = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, matricNumber: true, role: true, password: true },
  });
  if (!driver || driver.role !== "DRIVER") throw new Error("DRIVER_NOT_FOUND");

  if (typeof pin !== "string" || !/^\d{4}$/.test(pin.trim())) throw new Error("INVALID_PIN_FORMAT");
  if (!(await checkPin(`unlink:${driver.id}`, pin.trim(), driver.password))) throw new Error("INVALID_PIN");

  const mapping = await prisma.cardMapping.findUnique({ where: { student_uid: driver.matricNumber } });
  if (!mapping) throw new Error("CARD_NOT_LINKED");
  const cardUid = mapping.card_uid;

  await prisma.$transaction([
    prisma.cardMapping.deleteMany({ where: { card_uid: cardUid } }),
    prisma.driverCardCredential.deleteMany({ where: { driver_uid: driver.matricNumber } }),
    // A driver without a card must not stay logged into a terminal.
    prisma.terminal.updateMany({ where: { active_driver_uid: driver.matricNumber }, data: { active_driver_uid: null } }),
  ]);

  getRedisClient().del(cacheKeys.cardMap(cardUid)).catch(() => {});

  let terminalSyncSuccess = true;
  for (const list of ["DR", "WL"] as const) {
    try {
      const r = await terminalProvisioningService.deprovisionCard(cardUid, list);
      terminalSyncSuccess = terminalSyncSuccess && r.success;
    } catch (err) {
      terminalSyncSuccess = false;
      logger.error({ driverUid: driver.matricNumber, list, err: errText(err) }, "driver.card_unlink_terminal_sync_failed");
    }
  }

  notify(driver.matricNumber, "Card Unlinked", "Your driver card has been unlinked from your account.");
  logger.warn({ driverUid: driver.matricNumber, terminalSyncSuccess }, "driver.card_unlinked");

  return { success: true, message: "Card unlinked successfully", terminalSyncSuccess };
}

export {
  handleDriverLogin,
  handleDriverLogout,
  listDrivers,
  registerDriverByAgent,
  getDriverWallet,
  loginDriver,
  getDriverProfile,
  getDriverDashboard,
  getDriverRides,
  getBanks,
  verifyAndSaveDriverBank,
  resolveDriverBankAccount,
  createDriverWithdrawal,
  processWithdrawalPayout,
  handleDriverPayoutWebhook,
  reconcileStuckWithdrawals,
  getDriverWithdrawals,
  linkDriverCard,
  setDriverCardPin,
  getDriverPinStatus,
  unlinkDriverCard,
};