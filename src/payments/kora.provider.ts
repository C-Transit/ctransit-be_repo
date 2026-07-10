import crypto from "crypto";
import {
  IPaymentGateway,
  VirtualAccountResponse,
} from "./payment.interface.js";

export class KoraProvider implements IPaymentGateway {
  private secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  async createVirtualAccount(
    name: string,
    email: string,
    reference: string
  ): Promise<VirtualAccountResponse> {
    // TODO: Implement when Kora credentials are live
    // API: POST https://api.korapay.com/merchant/api/v1/virtual-bank-account
    // Headers: Authorization: Bearer {secretKey}, Content-Type: application/json
    // Body: { account_name, account_reference, permanent: true, customer: { name, email } }
    // Response mapping: response.data.data.{ account_number, bank_name }

    return {
      accountNumber: "KORA_PENDING_LIVE",
      bankName: "Kora Provider Bank",
      reference,
    };
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    // TODO: Implement when Kora credentials are live
    // Kora signs webhooks with HMAC-SHA512 using your secret key
    // Compare against the x-korapay-signature header value
    const expectedSignature = crypto
      .createHmac("sha512", this.secretKey)
      .update(rawBody)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}
