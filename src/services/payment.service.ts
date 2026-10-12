import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { paymentContainer } from "../payments/payment.container.js";
import type { CheckoutInitializationResponse } from "../payments/payment.interface.js";
import logger from "../config/logger.js";

const CHECKOUT_CURRENCY = "NGN";
const CHECKOUT_MINIMUM = 150;
const CHECKOUT_MAXIMUM = 10000;
const CHECKOUT_REDIRECT_URL = process.env.PAYMENT_REDIRECT_URL || "https://ctransit.me/dashboard";
const CHECKOUT_NOTIFICATION_URL =
  process.env.PAYMENT_NOTIFICATION_URL || "https://c-transit-pink.vercel.app/api/payments/webhook";

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
      wallet: { select: { is_linked: true } },
    },
  });

  if (!user) throw new Error("USER_NOT_FOUND");
  if (!user.wallet?.is_linked) throw new Error("WALLET_NOT_ACTIVATED");
  if (!paymentContainer.initializeCheckout) throw new Error("CHECKOUT_NOT_SUPPORTED");

  const reference = `CT-TOPUP-${randomUUID()}`;
  await prisma.paymentAttempt.create({
    data: { reference, provider: "KORA", userId: user.id, amount, currency: CHECKOUT_CURRENCY, status: "PENDING" },
  });

  try {
    const result = await paymentContainer.initializeCheckout({
      amount,
      currency: CHECKOUT_CURRENCY,
      reference,
      redirectUrl: CHECKOUT_REDIRECT_URL,
      notificationUrl: CHECKOUT_NOTIFICATION_URL,
      narration: "C-Transit wallet top-up",
      customer: { email: user.email, name: `${user.firstname} ${user.lastname}` },
    });

    await prisma.paymentAttempt.update({
      where: { reference },
      data: { providerReference: result.reference, status: "PROCESSING" },
    });

    return { ...result, status: "PENDING" };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : "Checkout failed";

    if (statusCode && statusCode >= 400 && statusCode < 500) {
      // Definitive rejection: Kora did not create a checkout.
      await prisma.paymentAttempt.update({
        where: { reference },
        data: { status: "FAILED", failureReason: message.slice(0, 255) },
      });
      throw error;
    }

    // Timeout, network error or 5xx: Kora may have created the checkout. Leave PENDING
    // so a signed charge.success can still complete this attempt.
    logger.warn({ reference, err: message }, "payment.checkout_outcome_ambiguous — attempt left PENDING");
    throw new Error("CHECKOUT_OUTCOME_UNKNOWN", { cause: error });
  }
}

export async function getCheckoutStatusForStudent(userId: string, reference: string) {
  const attempt = await prisma.paymentAttempt.findFirst({
    where: { reference, userId },
    select: { reference: true, amount: true, currency: true, status: true, completedAt: true },
  });

  if (!attempt) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");

  return { ...attempt, amount: Number(attempt.amount) };
}