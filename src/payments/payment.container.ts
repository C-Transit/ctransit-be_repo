import type { IPaymentGateway } from "./payment.interface.js";
import { KoraProvider } from "./provider.js";
import logger from "../config/logger.js";
import env from "../config/env.js";

// Kora is the only provider. To add another, implement IPaymentGateway and select it here.
if (env.payment.provider !== "KORA") {
  throw new Error(`FATAL: Unsupported payment provider: ${env.payment.provider}`);
}

export const paymentContainer: IPaymentGateway = new KoraProvider(
  env.payment.secretKey,
  env.payment.publicKey,
  undefined,
  {
    payoutWebhookUrl: env.payment.payoutWebhookUrl,
    payoutProxyUrl: env.payment.payoutProxyUrl,
    payoutProxySecret: env.payment.payoutProxySecret,
  }
);
logger.info("payment.provider_loaded — KORA");