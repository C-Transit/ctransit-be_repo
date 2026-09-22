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

export interface PayoutDestination {
  type: "bank_account";
  amount: number;
  currency: string;
  narration?: string;
  bank_account: {
    bank: string;
    account: string;
  };
}

export interface PayoutCustomer {
  name: string;
  email: string;
}

export interface PayoutParams {
  reference: string;
  amount: number;
  destination: PayoutDestination;
  customer: PayoutCustomer;
}

export interface PayoutResponse {
  success: boolean;
  status: "processing" | "pending" | "success" | "failed" | "ambiguous_timeout";
  reference: string;
  koraReference?: string;
  fee?: number;
  message?: string;
  rawResponse?: unknown;
}

export interface PayoutStatusQuery {
  status: "processing" | "pending" | "success" | "failed" | "not_found" | "unknown";
  reference: string;
  koraReference?: string;
  amount?: number;
  fee?: number;
  message?: string;
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

  // Initiates an outbound bank payout
  initiatePayout?(params: PayoutParams): Promise<PayoutResponse>;

  // Queries the current status of an outbound payout
  verifyPayout?(reference: string): Promise<PayoutStatusQuery>;
}
