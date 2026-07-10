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

const PROVIDER = process.env.PAYMENT_PROVIDER ?? "MOCK";
const SECRET_KEY = process.env.PAYMENT_SECRET_KEY ?? "dummy_key";

let paymentContainer: IPaymentGateway;

switch (PROVIDER) {
  case "KORA":
    paymentContainer = new KoraProvider(SECRET_KEY);
    logger.info("payment.provider_loaded — KORA");
    break;
  case "FINCRA":
    paymentContainer = new FincraProvider(SECRET_KEY);
    logger.info("payment.provider_loaded — FINCRA");
    break;
  default:
    paymentContainer = new MockProvider();
    logger.info("payment.provider_loaded — MOCK (beta sandbox)");
    break;
}

export { paymentContainer };
