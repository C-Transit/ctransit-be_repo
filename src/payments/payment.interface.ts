// src/payments/payment.interface.ts
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

export interface BankAccountResolution {
  accountName: string;
  accountNumber: string;
  bankCode: string;
  bankName?: string;
}

export interface CheckoutInitializationParams {
  amount: number;
  currency: string;
  reference: string;
  redirectUrl: string;
  notificationUrl: string;
  narration: string;
  customer: PayoutCustomer;
}

export interface CheckoutInitializationResponse {
  reference: string;
  checkoutUrl: string;
}

// Result of asking Kora about a checkout charge. "unknown" means we could not
// get a trustworthy answer (timeout, HTTP error, malformed body); callers must
// never treat it as a failure.
export interface ChargeStatusQuery {
  status: "success" | "failed" | "processing" | "pending" | "not_found" | "unknown";
  reference: string;
  amount?: number;
  currency?: string;
  message?: string;
}

export interface BankInfo {
  name: string;
  code: string;
}

export interface IPaymentGateway {
  // Verifies the HMAC signature of an incoming provider webhook.
  verifyWebhook(rawBody: string, signature: string): boolean;

  // Initiates an outbound bank payout
  initiatePayout?(params: PayoutParams): Promise<PayoutResponse>;

  // Queries the current status of an outbound payout
  verifyPayout?(reference: string): Promise<PayoutStatusQuery>;

  // Resolves and verifies a bank account number against bank name
  resolveBankAccount?(
    bankCode: string,
    accountNumber: string
  ): Promise<BankAccountResolution>;

  initializeCheckout?(
    params: CheckoutInitializationParams
  ): Promise<CheckoutInitializationResponse>;

  // Queries the current status of a checkout charge by merchant reference.
  verifyCharge?(reference: string): Promise<ChargeStatusQuery>;

  // Lists supported banks with the provider's own bank codes.
  listBanks?(): Promise<BankInfo[]>;
}