import {
  IPaymentGateway,
  PayoutParams,
  PayoutResponse,
  PayoutStatusQuery,
  VirtualAccountResponse,
  BankAccountResolution,
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

  async resolveBankAccount(
    bankCode: string,
    accountNumber: string
  ): Promise<BankAccountResolution> {
    const cleanAccount = accountNumber ? accountNumber.trim() : "";
    if (!/^\d{10}$/.test(cleanAccount) || cleanAccount === "0000000000") {
      throw new Error("Invalid bank account number");
    }

    return {
      accountName: "MOCK VERIFIED ACCOUNT HOLDER",
      accountNumber: cleanAccount,
      bankCode: bankCode || "058",
      bankName: "Mock Test Bank",
    };
  }

  verifyWebhook(_rawBody: string, signature: string): boolean {
    if (
      !signature ||
      signature.trim() === "" ||
      signature === "invalid_signature" ||
      signature === "invalid" ||
      signature.includes("invalid")
    ) {
      return false;
    }
    return true;
  }

  async initiatePayout(params: PayoutParams): Promise<PayoutResponse> {
    return {
      success: true,
      status: "processing",
      reference: params.reference,
      koraReference: `KORA-MOCK-${Date.now()}`,
      fee: 10.75,
      message: "Mock payout initiated successfully in processing state",
    };
  }

  async verifyPayout(reference: string): Promise<PayoutStatusQuery> {
    return {
      status: "processing",
      reference,
      koraReference: `KORA-MOCK-${Date.now()}`,
      fee: 10.75,
      message: "Mock payout status verified",
    };
  }
}
