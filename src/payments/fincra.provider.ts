import crypto from "crypto";
import {
  IPaymentGateway,
  VirtualAccountResponse,
} from "./payment.interface.js";

export class FincraProvider implements IPaymentGateway {
  private secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  async createVirtualAccount(
    name: string,
    email: string,
    reference: string
  ): Promise<VirtualAccountResponse> {
    // TODO: Implement when Fincra credentials are live
    // API: POST https://sandboxapi.fincra.com/profile/virtual-accounts/requests
    // Headers: api-key: {secretKey}, Content-Type: application/json
    // Body: {
    //   currency: "NGN",
    //   accountType: "individual",
    //   channel: "providus",
    //   merchantReference: reference,
    //   KYCInformation: {
    //     firstName: name.split(" ")[0],
    //     lastName: name.split(" ")[1] || "Student",
    //     email
    //   }
    // }
    // Response mapping: response.data.data.{ accountNumber, bankName }

    return {
      accountNumber: "FINCRA_PENDING_LIVE",
      bankName: "Fincra Provider Bank",
      reference,
    };
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    // TODO: Implement when Fincra credentials are live
    // Fincra sends a signature in the fincra-signature header
    // Verify using HMAC-SHA256 with your secret key
    const expectedSignature = crypto
      .createHmac("sha256", this.secretKey)
      .update(rawBody)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}
