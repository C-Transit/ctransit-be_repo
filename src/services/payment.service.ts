// src/services/payment.service.ts
//
// Business logic layer between the payment container and the route.
// Controllers never call paymentContainer directly — they call this service.
// Keeps the controller thin and the payment logic testable.

import prisma from "../lib/prisma.js";
import { paymentContainer } from "../payments/payment.container.js";
import { sendNotification } from "./notification.service.js";
import logger from "../config/logger.js";

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
    { accountNumber: result.accountNumber, bankName: result.bankName },
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
