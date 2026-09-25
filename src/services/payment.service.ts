import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { paymentContainer } from "../payments/payment.container.js";
import type { CheckoutInitializationResponse } from "../payments/payment.interface.js";
import { sendNotification } from "./notification.service.js";
import logger from "../config/logger.js";

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4
    ? `${"*".repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`
    : "****";
}

const CHECKOUT_CURRENCY = "NGN";
const CHECKOUT_MINIMUM = 150;
const CHECKOUT_MAXIMUM = 10000;
const CHECKOUT_REDIRECT_URL =
  process.env.PAYMENT_REDIRECT_URL || "https://ctransit.me/dashboard";
const CHECKOUT_NOTIFICATION_URL =
  process.env.PAYMENT_NOTIFICATION_URL ||
  "https://c-transit-pink.vercel.app/api/payments/webhook";

export async function initializeCheckoutForStudent(
  userId: string,
  amount: number
): Promise<CheckoutInitializationResponse & { status: "PENDING" }> {
  if (!Number.isInteger(amount) || amount < CHECKOUT_MINIMUM || amount > CHECKOUT_MAXIMUM) {
    throw new Error("INVALID_CHECKOUT_AMOUNT");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      matricNumber: true,
      wallet: { select: { is_linked: true } },
    },
  });

  if (!user) throw new Error("USER_NOT_FOUND");
  if (!user.wallet?.is_linked) throw new Error("WALLET_NOT_ACTIVATED");
  if (!paymentContainer.initializeCheckout) {
    throw new Error("CHECKOUT_NOT_SUPPORTED");
  }

  const reference = `CT-TOPUP-${randomUUID()}`;
  await prisma.paymentAttempt.create({
    data: {
      reference,
      provider: "KORA",
      userId: user.id,
      amount,
      currency: CHECKOUT_CURRENCY,
      status: "PENDING",
    },
  });

  try {
    const result = await paymentContainer.initializeCheckout({
      amount,
      currency: CHECKOUT_CURRENCY,
      reference,
      redirectUrl: CHECKOUT_REDIRECT_URL,
      notificationUrl: CHECKOUT_NOTIFICATION_URL,
      narration: "C-Transit wallet top-up",
      customer: {
        email: user.email,
        name: `${user.firstname} ${user.lastname}`,
      },
    });

    await prisma.paymentAttempt.update({
      where: { reference },
      data: { providerReference: result.reference, status: "PROCESSING" },
    });

    return { ...result, status: "PENDING" };
  } catch (error) {
    await prisma.paymentAttempt.update({
      where: { reference },
      data: {
        status: "FAILED",
        failureReason: error instanceof Error ? error.message : "Checkout failed",
      },
    });
    throw error;
  }
}

export async function getCheckoutStatusForStudent(
  userId: string,
  reference: string
) {
  const attempt = await prisma.paymentAttempt.findFirst({
    where: { reference, userId },
    select: {
      reference: true,
      amount: true,
      currency: true,
      status: true,
      completedAt: true,
    },
  });

  if (!attempt) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");

  return {
    reference: attempt.reference,
    amount: Number(attempt.amount),
    currency: attempt.currency,
    status: attempt.status,
    completedAt: attempt.completedAt,
  };
}

// ─────────────────────────────────────────────
// createVirtualAccountForStudent
// Called once after KYC approval when the student
// requests their dedicated top-up account.
//
// Guards:
// - Student must exist and have an approved wallet
// - Virtual account must not already exist (idempotent)
//
// On success: persists accountNumber + bankName to Wallet,
// returns the account details to the controller.
// ─────────────────────────────────────────────
export async function createVirtualAccountForStudent(userId: string) {
  const log = logger.child({ userId });

  // Fetch user + wallet in one query
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      matricNumber: true,
      wallet: {
        select: {
          student_uid: true,
          is_linked: true,
          v_account_number: true,
          v_bank_name: true,
        },
      },
    },
  });

  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  if (!user.wallet || !user.wallet.is_linked) {
    // Wallet doesn't exist or KYC not approved yet
    throw new Error("WALLET_NOT_ACTIVATED");
  }

  // Idempotency — return existing account if already created
  if (user.wallet.v_account_number) {
    log.info("payment.virtual_account_already_exists — returning cached");
    return {
      accountNumber: user.wallet.v_account_number,
      bankName: user.wallet.v_bank_name,
      reference: `CTRANSIT-${user.matricNumber}`,
      alreadyExisted: true,
    };
  }

  // Build a stable reference tied to the student's matric number
  // Using matricNumber (not timestamp) so re-requests return the same reference
  const reference = `CTRANSIT-${user.matricNumber}`;
  const fullName = `${user.firstname} ${user.lastname}`;

  log.info({ reference }, "payment.creating_virtual_account");

  const result = await paymentContainer.createVirtualAccount(
    fullName,
    user.email,
    reference
  );

  // Persist to wallet
  await prisma.wallet.update({
    where: { student_uid: user.matricNumber },
    data: {
      v_account_number: result.accountNumber,
      v_bank_name: result.bankName,
    },
  });

  sendNotification(
    user.matricNumber,
    "Virtual Account Ready",
    `Your dedicated top-up account is ready. Bank: ${result.bankName}, Account: ${result.accountNumber}. Transfer money to this account to fund your wallet.`
  ).catch(() => {});

  log.info(
    {
      accountNumber: maskAccountNumber(result.accountNumber),
      bankName: result.bankName,
    },
    "payment.virtual_account_created"
  );

  return {
    accountNumber: result.accountNumber,
    bankName: result.bankName,
    reference: result.reference,
    alreadyExisted: false,
  };
}

// ─────────────────────────────────────────────
// getVirtualAccount
// Returns the student's existing virtual account
// details without creating a new one.
// Used by the wallet info endpoint.
// ─────────────────────────────────────────────
export async function getVirtualAccount(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      matricNumber: true,
      wallet: {
        select: {
          v_account_number: true,
          v_bank_name: true,
          balance: true,
        },
      },
    },
  });

  if (!user || !user.wallet) {
    throw new Error("WALLET_NOT_FOUND");
  }

  return {
    accountNumber: user.wallet.v_account_number,
    bankName: user.wallet.v_bank_name,
    balance: parseFloat(user.wallet.balance.toString()),
  };
}
