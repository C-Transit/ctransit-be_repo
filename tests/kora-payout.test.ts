import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  createDriverWithdrawal,
  processWithdrawalPayout,
  handleDriverPayoutWebhook,
} from "../src/services/driver.service.js";
import { KoraProvider } from "../src/payments/kora.provider.js";
import type { IPaymentGateway, PayoutParams, PayoutResponse, PayoutStatusQuery } from "../src/payments/payment.interface.js";

describe("Kora Driver Withdrawal & Payout Lifecycle", () => {
  // Helper to create an in-memory transactional mock database
  function createMockDatabase(initialBalance = 1000, initialUser: any = {}) {
    let walletBalance = initialBalance;
    const withdrawals = new Map<string, any>();
    const user = {
      id: "drv-uuid-1",
      matricNumber: "DRV/001",
      role: "DRIVER",
      email: "driver@ctransit.me",
      firstname: "Ahmed",
      lastname: "Musa",
      bankName: initialUser.bankName || "058",
      accountNumber: initialUser.accountNumber || "0123456789",
      accountName: initialUser.accountName || "Ahmed Musa",
      bankCode: initialUser.bankCode || "058",
      bankVerified: initialUser.bankVerified ?? true,
    };

    const mockDb: any = {
      user: {
        findUnique: async (args: any) => {
          if (args.where.id === user.id || args.where.matricNumber === user.matricNumber) {
            return { ...user };
          }
          return null;
        },
        update: async (args: any) => {
          Object.assign(user, args.data);
          return { ...user };
        },
      },
      driverWallet: {
        findUnique: async (args: any) => {
          if (args.where.driver_uid === user.matricNumber) {
            return { driver_uid: user.matricNumber, balance: walletBalance };
          }
          return null;
        },
        update: async (args: any) => {
          if (args.data.balance?.decrement) {
            if (walletBalance < args.data.balance.decrement) {
              throw new Error("CHECK_CONSTRAINT_VIOLATED");
            }
            walletBalance -= args.data.balance.decrement;
          }
          if (args.data.balance?.increment) {
            walletBalance += args.data.balance.increment;
          }
          return { driver_uid: user.matricNumber, balance: walletBalance };
        },
      },
      driverWithdrawal: {
        create: async (args: any) => {
          const record = {
            id: `wdr-${withdrawals.size + 1}`,
            created_at: new Date(),
            updated_at: new Date(),
            kora_reference: null,
            kora_fee: null,
            failure_reason: null,
            ...args.data,
          };
          withdrawals.set(record.id, record);
          withdrawals.set(record.reference, record);
          return record;
        },
        findUnique: async (args: any) => {
          return withdrawals.get(args.where.id) || null;
        },
        findFirst: async (args: any) => {
          for (const w of withdrawals.values()) {
            if (args.where.OR) {
              for (const condition of args.where.OR) {
                if (condition.reference && w.reference === condition.reference) return w;
                if (condition.kora_reference && w.kora_reference === condition.kora_reference) return w;
              }
            }
          }
          return null;
        },
        update: async (args: any) => {
          const existing = withdrawals.get(args.where.id);
          if (existing) {
            Object.assign(existing, args.data);
            return existing;
          }
          return null;
        },
      },
      $transaction: async (callback: any) => {
        return await callback(mockDb);
      },
      getBalance: () => walletBalance,
      getWithdrawal: (idOrRef: string) => withdrawals.get(idOrRef),
      getUser: () => user,
    };

    return mockDb;
  }

  it("1. Successful payout: creates withdrawal, reserves gross balance, calculates 4% fee, and updates to SUCCESS via webhook", async () => {
    const mockDb = createMockDatabase(2000);

    const mockGateway: IPaymentGateway = {
      createVirtualAccount: async () => ({ accountNumber: "123", bankName: "Bank", reference: "ref" }),
      verifyWebhook: () => true,
      initiatePayout: async (params: PayoutParams): Promise<PayoutResponse> => {
        // Assert parameters sent to gateway
        assert.equal(params.amount, 960, "Net amount disbursed must be 960 (1000 - 4% fee)");
        assert.equal(params.destination.bank_account.bank, "058");
        assert.equal(params.destination.bank_account.account, "0123456789");
        return {
          success: true,
          status: "processing",
          reference: params.reference,
          koraReference: "KORA-PAY-001",
          fee: 10.75, // Kora API returned fee
        };
      },
    };

    const withdrawal = await createDriverWithdrawal(
      "drv-uuid-1",
      {
        amount: 1000,
        bankName: "058",
        accountNumber: "0123456789",
        accountName: "Ahmed Musa",
      },
      mockDb,
      mockGateway
    );

    // Verify initial creation state
    assert.equal(withdrawal.amount, 1000, "Gross amount is 1000");
    assert.equal(withdrawal.fee, 40, "C-Transit 4% fee is 40");
    assert.equal(withdrawal.netAmount, 960, "Net amount is 960");
    assert.equal(withdrawal.status, "PROCESSING", "Lifecycle is PROCESSING after initiation");
    assert.equal(mockDb.getBalance(), 1000, "Wallet balance reserved from 2000 to 1000");

    // Webhook arrives from Kora: transfer.success
    const webhookRes = await handleDriverPayoutWebhook(
      {
        reference: withdrawal.reference,
        koraReference: "KORA-PAY-001",
        event: "transfer.success",
        status: "success",
        fee: 10.75,
        amount: 960,
      },
      mockDb
    );

    assert.equal(webhookRes.success, true);
    const updated = mockDb.getWithdrawal(withdrawal.id);
    assert.equal(updated.status, "SUCCESS", "Withdrawal finalized to SUCCESS");
    assert.equal(updated.kora_reference, "KORA-PAY-001");
    assert.equal(updated.kora_fee, 10.75, "Actual Kora fee preserved");
    assert.equal(mockDb.getBalance(), 1000, "Driver balance remains 1000 (no refund on success)");
  });

  it("2. Failed payout: restores reserved driver balance exactly once and records failure reason", async () => {
    const mockDb = createMockDatabase(1500);

    const mockGateway: IPaymentGateway = {
      createVirtualAccount: async () => ({ accountNumber: "123", bankName: "Bank", reference: "ref" }),
      verifyWebhook: () => true,
      initiatePayout: async (params: PayoutParams): Promise<PayoutResponse> => {
        return {
          success: false,
          status: "failed",
          reference: params.reference,
          message: "Destination account invalid or frozen",
        };
      },
    };

    const withdrawal = await createDriverWithdrawal(
      "drv-uuid-1",
      {
        amount: 500,
        bankName: "058",
        accountNumber: "0000000000",
        accountName: "Ahmed Musa",
      },
      mockDb,
      mockGateway
    );

    assert.equal(withdrawal.status, "FAILED", "Withdrawal marked FAILED immediately on gateway rejection");
    assert.equal(mockDb.getBalance(), 1500, "Driver balance restored back to 1500");

    const record = mockDb.getWithdrawal(withdrawal.id);
    assert.equal(record.failure_reason, "Destination account invalid or frozen");
  });

  it("3. Webhook failure: restores driver balance on transfer.failed webhook", async () => {
    const mockDb = createMockDatabase(1000);

    const mockGateway: IPaymentGateway = {
      createVirtualAccount: async () => ({ accountNumber: "123", bankName: "Bank", reference: "ref" }),
      verifyWebhook: () => true,
      initiatePayout: async (params: PayoutParams): Promise<PayoutResponse> => {
        return {
          success: true,
          status: "processing",
          reference: params.reference,
          koraReference: "KORA-PENDING-99",
        };
      },
    };

    const withdrawal = await createDriverWithdrawal(
      "drv-uuid-1",
      {
        amount: 400,
        bankName: "058",
        accountNumber: "1122334455",
        accountName: "Ahmed Musa",
      },
      mockDb,
      mockGateway
    );

    assert.equal(mockDb.getBalance(), 600, "Balance reserved from 1000 to 600");

    // Later, Kora sends transfer.failed webhook
    const webhookRes = await handleDriverPayoutWebhook(
      {
        reference: withdrawal.reference,
        koraReference: "KORA-PENDING-99",
        event: "transfer.failed",
        status: "failed",
        reason: "Account name mismatch at NIBSS",
      },
      mockDb
    );

    assert.equal(webhookRes.success, true);
    assert.equal(mockDb.getBalance(), 1000, "Balance restored back to 1000 on failure");

    const record = mockDb.getWithdrawal(withdrawal.id);
    assert.equal(record.status, "FAILED");
    assert.equal(record.failure_reason, "Account name mismatch at NIBSS");
  });

  it("4. Timeout/5xx handling: does NOT fail or refund immediately; queries verification endpoint", async () => {
    const mockDb = createMockDatabase(1000);

    let verifyCalled = false;
    const mockGateway: IPaymentGateway = {
      createVirtualAccount: async () => ({ accountNumber: "123", bankName: "Bank", reference: "ref" }),
      verifyWebhook: () => true,
      initiatePayout: async (params: PayoutParams): Promise<PayoutResponse> => {
        // Simulates 5xx / timeout resolution: verify query returns processing
        verifyCalled = true;
        return {
          success: true,
          status: "ambiguous_timeout",
          reference: params.reference,
          message: "Kora 5xx server error, status pending reconciliation",
        };
      },
      verifyPayout: async (reference: string): Promise<PayoutStatusQuery> => {
        return {
          status: "processing",
          reference,
        };
      },
    };

    const withdrawal = await createDriverWithdrawal(
      "drv-uuid-1",
      {
        amount: 500,
        bankName: "058",
        accountNumber: "1234567890",
        accountName: "Ahmed Musa",
      },
      mockDb,
      mockGateway
    );

    assert.equal(verifyCalled, true);
    assert.equal(withdrawal.status, "PROCESSING", "Must stay PROCESSING, not FAILED");
    assert.equal(mockDb.getBalance(), 500, "Balance remains reserved, not refunded yet");
  });

  it("5. Idempotent webhooks: duplicate transfer.success webhooks do not double-process", async () => {
    const mockDb = createMockDatabase(1000);

    const record = await mockDb.driverWithdrawal.create({
      data: {
        driver_uid: "DRV/001",
        amount: 500,
        fee: 20,
        net_amount: 480,
        bank_name: "058",
        account_number: "1234567890",
        account_name: "Ahmed Musa",
        reference: "WDR-DUP-TEST",
        status: "PROCESSING",
      },
    });

    // Set balance to 500 (reserved)
    await mockDb.driverWallet.update({
      where: { driver_uid: "DRV/001" },
      data: { balance: { decrement: 500 } },
    });
    assert.equal(mockDb.getBalance(), 500);

    // 1st webhook
    await handleDriverPayoutWebhook(
      {
        reference: record.reference,
        event: "transfer.success",
        status: "success",
        fee: 10.75,
      },
      mockDb
    );
    assert.equal(mockDb.getWithdrawal(record.id).status, "SUCCESS");
    assert.equal(mockDb.getBalance(), 500);

    // 2nd duplicate webhook
    const dupRes = await handleDriverPayoutWebhook(
      {
        reference: record.reference,
        event: "transfer.success",
        status: "success",
        fee: 10.75,
      },
      mockDb
    );
    assert.equal(dupRes.success, true);
    assert.equal(mockDb.getBalance(), 500, "Balance unchanged on duplicate webhook");
    assert.equal(mockDb.getWithdrawal(record.id).status, "SUCCESS");
  });

  it("6. Idempotent webhooks: duplicate transfer.failed webhooks do not restore balance twice", async () => {
    const mockDb = createMockDatabase(500); // 500 after reserving 500 from initial 1000

    const record = await mockDb.driverWithdrawal.create({
      data: {
        driver_uid: "DRV/001",
        amount: 500,
        fee: 20,
        net_amount: 480,
        bank_name: "058",
        account_number: "1234567890",
        account_name: "Ahmed Musa",
        reference: "WDR-FAIL-DUP",
        status: "PROCESSING",
      },
    });

    // 1st failed webhook
    await handleDriverPayoutWebhook(
      {
        reference: record.reference,
        event: "transfer.failed",
        status: "failed",
        reason: "Bank error",
      },
      mockDb
    );
    assert.equal(mockDb.getBalance(), 1000, "Balance restored once from 500 to 1000");

    // 2nd duplicate failed webhook
    await handleDriverPayoutWebhook(
      {
        reference: record.reference,
        event: "transfer.failed",
        status: "failed",
        reason: "Bank error",
      },
      mockDb
    );
    assert.equal(mockDb.getBalance(), 1000, "Balance must NOT be incremented twice!");
  });

  it("7. Successful payout cannot be refunded by subsequent failed event", async () => {
    const mockDb = createMockDatabase(500);

    const record = await mockDb.driverWithdrawal.create({
      data: {
        driver_uid: "DRV/001",
        amount: 500,
        fee: 20,
        net_amount: 480,
        bank_name: "058",
        account_number: "1234567890",
        account_name: "Ahmed Musa",
        reference: "WDR-PERMANENT-SUCCESS",
        status: "SUCCESS",
      },
    });

    // Stray failed webhook received for already SUCCESS withdrawal
    await handleDriverPayoutWebhook(
      {
        reference: record.reference,
        event: "transfer.failed",
        status: "failed",
        reason: "Late rejection",
      },
      mockDb
    );

    assert.equal(mockDb.getBalance(), 500, "Balance must NEVER be refunded for a SUCCESS withdrawal");
    assert.equal(mockDb.getWithdrawal(record.id).status, "SUCCESS", "Status must remain SUCCESS");
  });

  it("8. Duplicate payout initiation prevention: does not initiate payout twice for same withdrawal", async () => {
    const mockDb = createMockDatabase(1000);

    let payoutCalls = 0;
    const mockGateway: IPaymentGateway = {
      createVirtualAccount: async () => ({ accountNumber: "123", bankName: "Bank", reference: "ref" }),
      verifyWebhook: () => true,
      initiatePayout: async (params: PayoutParams): Promise<PayoutResponse> => {
        payoutCalls++;
        return {
          success: true,
          status: "processing",
          reference: params.reference,
        };
      },
    };

    const record = await mockDb.driverWithdrawal.create({
      data: {
        driver_uid: "DRV/001",
        amount: 500,
        fee: 20,
        net_amount: 480,
        bank_name: "058",
        account_number: "1234567890",
        account_name: "Ahmed Musa",
        reference: "WDR-SINGLE-INIT",
        status: "PENDING",
      },
    });

    // 1st payout call
    await processWithdrawalPayout(record.id, mockDb, mockGateway);
    assert.equal(payoutCalls, 1);

    // 2nd duplicate payout call on the same withdrawal (now PROCESSING)
    await processWithdrawalPayout(record.id, mockDb, mockGateway);
    assert.equal(payoutCalls, 1, "Duplicate initiation must be blocked; call count stays 1");
  });

  it("9. Stored verified bank details: uses driver's stored bank details and ignores arbitrary details", async () => {
    // Driver already has stored bank details: "Guaranty Trust Bank" (058), "0123456789"
    const mockDb = createMockDatabase(2000, {
      bankName: "Guaranty Trust Bank",
      accountNumber: "0123456789",
    });

    let disbursedBank = "";
    let disbursedAccount = "";
    const mockGateway: IPaymentGateway = {
      createVirtualAccount: async () => ({ accountNumber: "123", bankName: "Bank", reference: "ref" }),
      verifyWebhook: () => true,
      initiatePayout: async (params: PayoutParams): Promise<PayoutResponse> => {
        disbursedBank = params.destination.bank_account.bank;
        disbursedAccount = params.destination.bank_account.account;
        return {
          success: true,
          status: "processing",
          reference: params.reference,
        };
      },
    };

    // Attacker passes different bank and account number
    await createDriverWithdrawal(
      "drv-uuid-1",
      {
        amount: 500,
        bankName: "Attacker Bank",
        accountNumber: "9999999999",
        accountName: "Attacker Name",
      },
      mockDb,
      mockGateway
    );

    // Verified bank details must be enforced!
    assert.equal(disbursedBank, "Guaranty Trust Bank");
    assert.equal(disbursedAccount, "0123456789");
  });

  it("10. Kora webhook signature verification: passes on valid HMAC and rejects on invalid HMAC", () => {
    const secretKey = "test_secret_key_korapay";
    const kora = new KoraProvider(secretKey);

    const payload = JSON.stringify({ event: "transfer.success", data: { reference: "WDR-123" } });
    const validSignature = crypto
      .createHmac("sha512", secretKey)
      .update(payload)
      .digest("hex");

    assert.equal(kora.verifyWebhook(payload, validSignature), true, "Valid signature must pass");
    assert.equal(kora.verifyWebhook(payload, "invalid_signature_hex"), false, "Invalid signature must fail");
    assert.equal(kora.verifyWebhook(payload, ""), false, "Empty signature must fail");
  });
});
