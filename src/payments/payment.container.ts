import { IPaymentGateway } from "./payment.interface.js";
import { MockProvider } from "./mock.provider.js";
import { KoraProvider } from "./kora.provider.js";
import { FincraProvider } from "./fincra.provider.js";
import logger from "../config/logger.js";
import env from "../config/env.js";

const PROVIDER = (env.payment.provider || "MOCK").toUpperCase();
const SECRET_KEY = env.payment.secretKey;
const isLiveLikeEnvironment =
  env.NODE_ENV === "production" || env.NODE_ENV === "staging";
const allowMockPayments =
  !isLiveLikeEnvironment && process.env.ALLOW_MOCK_PAYMENTS === "true";

let paymentContainer: IPaymentGateway;

switch (PROVIDER) {
  case "MOCK":
    if (isLiveLikeEnvironment) {
      throw new Error(
        "FATAL: MOCK payment provider is strictly prohibited in production-like environments."
      );
    }
    if (!allowMockPayments) {
      throw new Error(
        "FATAL: MOCK payment provider requires ALLOW_MOCK_PAYMENTS=true."
      );
    }
    paymentContainer = new MockProvider();
    logger.warn("payment.provider_loaded — MOCK (explicitly enabled for testing)");
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
