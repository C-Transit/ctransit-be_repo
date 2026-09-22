// src/payments/payment.container.ts
//
// Reads PAYMENT_PROVIDER from env and exports the active provider.
// This is the only place that knows which provider is live.
//
// To switch providers: change PAYMENT_PROVIDER in .env — no other code changes.
//
// Valid values:
//   MOCK   → MockProvider (beta sandbox, default)
//   KORA   → KoraProvider (production, requires PAYMENT_SECRET_KEY)
//   FINCRA → FincraProvider (production, requires PAYMENT_SECRET_KEY)

import { IPaymentGateway } from "./payment.interface.js";
import { MockProvider } from "./mock.provider.js";
import { KoraProvider } from "./kora.provider.js";
import { FincraProvider } from "./fincra.provider.js";
import logger from "../config/logger.js";
import env from "../config/env.js";

const PROVIDER = (env.payment.provider || "MOCK").toUpperCase();
const SECRET_KEY = env.payment.secretKey;
const allowMockPayments = process.env.ALLOW_MOCK_PAYMENTS === "true";

let paymentContainer: IPaymentGateway;

switch (PROVIDER) {
  case "MOCK":
    if (!allowMockPayments) {
      throw new Error(
        "FATAL: MOCK payment provider requires ALLOW_MOCK_PAYMENTS=true."
      );
    }
    paymentContainer = new MockProvider();
    logger.warn("payment.provider_loaded — MOCK (explicitly enabled)");
    break;
  case "KORA":
    if (!SECRET_KEY) {
      throw new Error("FATAL: PAYMENT_SECRET_KEY is required when using KORA provider.");
    }
    paymentContainer = new KoraProvider(SECRET_KEY);
    logger.info("payment.provider_loaded — KORA");
    break;
  case "FINCRA":
    if (!SECRET_KEY) {
      throw new Error("FATAL: PAYMENT_SECRET_KEY is required when using FINCRA provider.");
    }
    paymentContainer = new FincraProvider(SECRET_KEY);
    logger.info("payment.provider_loaded — FINCRA");
    break;
  default:
    throw new Error(`FATAL: Unsupported payment provider: ${PROVIDER}`);
}

export { paymentContainer };
