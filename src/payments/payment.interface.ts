// src/payments/payment.interface.ts
//
// System-wide contract all payment providers must implement.
// The application logic only ever talks to this interface —
// never to a concrete provider directly.

export interface VirtualAccountResponse {
  accountNumber: string;
  bankName: string;
  reference: string;
}

export interface IPaymentGateway {
  // Creates a dedicated virtual bank account for a student.
  // Called once after KYC approval — account details persisted to Wallet.
  createVirtualAccount(
    name: string,
    email: string,
    reference: string
  ): Promise<VirtualAccountResponse>;

  // Verifies the authenticity of an incoming webhook from the provider.
  // Mock always returns true — live providers verify HMAC signatures.
  verifyWebhook(rawBody: string, signature: string): boolean;
}
