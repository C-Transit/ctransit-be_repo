// src/payments/mock.provider.ts
//
// Beta sandbox provider — used during the 10-day test window.
// Generates a fake 10-digit account number instantly.
// verifyWebhook always returns true so test payloads
// from curl/Postman pass through without a real signature.
//
// Switch away from this by setting PAYMENT_PROVIDER=KORA or FINCRA.

import {
  IPaymentGateway,
  VirtualAccountResponse,
} from "./payment.interface.js";

export class MockProvider implements IPaymentGateway {
  async createVirtualAccount(
    _name: string,
    _email: string,
    reference: string
  ): Promise<VirtualAccountResponse> {
    // Generate a random 10-digit account number
    const fakeAccountNumber = Math.floor(
      1000000000 + Math.random() * 9000000000
    ).toString();

    return {
      accountNumber: fakeAccountNumber,
      bankName: "CTransit Simulation Bank",
      reference,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  verifyWebhook(_rawBody: string, _signature: string): boolean {
    // Bypass signature validation for local testing
    return true;
  }
}
