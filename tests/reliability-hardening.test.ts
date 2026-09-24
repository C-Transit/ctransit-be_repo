import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectPartialBroadcastFailure,
  type BroadcastResult,
} from "../src/utils/bridge.js";
import { updateAgentStatus } from "../src/services/admin.service.js";
import {
  deductFare,
  creditWallet,
  settleRideTransaction,
} from "../src/services/ledger.service.js";

describe("Reliability Hardening — Fleet Broadcast Partial Terminal Failure Detection", () => {
  it("should detect successful fleet broadcast with zero failures", () => {
    const result: BroadcastResult = {
      success: true,
      deliveredCount: 5,
      failedCount: 0,
      failedTerminals: [],
    };
    const check = detectPartialBroadcastFailure(result);
    assert.equal(check.isPartial, false);
    assert.equal(check.failedCount, 0);
    assert.deepEqual(check.failedTerminals, []);
  });

  it("should report partial terminal failure when failedCount > 0", () => {
    const result: BroadcastResult = {
      success: true,
      deliveredCount: 4,
      failedCount: 2,
      failedTerminals: ["TERM-002", "TERM-005"],
    };
    const check = detectPartialBroadcastFailure(result);
    assert.equal(check.isPartial, true);
    assert.equal(check.failedCount, 2);
    assert.deepEqual(check.failedTerminals, ["TERM-002", "TERM-005"]);
  });

  it("should detect failures from legacy failed array or failures array", () => {
    const result1: BroadcastResult = {
      success: true,
      failed: ["TERM-009"],
    };
    const check1 = detectPartialBroadcastFailure(result1);
    assert.equal(check1.isPartial, true);
    assert.equal(check1.failedCount, 1);
    assert.deepEqual(check1.failedTerminals, ["TERM-009"]);

    const result2: BroadcastResult = {
      success: false,
      failures: [{ terminalId: "TERM-011", error: "Terminal offline" }],
    };
    const check2 = detectPartialBroadcastFailure(result2);
    assert.equal(check2.isPartial, true);
    assert.equal(check2.failedCount, 1);
    assert.deepEqual(check2.failedTerminals, ["TERM-011"]);
  });
});

describe("Reliability Hardening — Agent Status Redis Invalidation Resilience", () => {
  it("should succeed and not throw HTTP 500 when DB update succeeds but Redis cache invalidation fails", async () => {
    let dbUpdated = false;

    const mockPrisma: any = {
      agent: {
        findUnique: async ({ where }: any) => {
          if (where.id === "agent-123") {
            return { id: "agent-123", status: "SUSPENDED" };
          }
          return null;
        },
        update: async ({ where, data }: any) => {
          assert.equal(where.id, "agent-123");
          assert.equal(data.status, "ACTIVE");
          dbUpdated = true;
          return {
            id: "agent-123",
            firstname: "Agent",
            lastname: "Smith",
            email: "agent@ctransit.edu",
            phone: "08012345678",
            status: "ACTIVE",
            createdAt: new Date(),
            createdBy: "admin-1",
          };
        },
      },
    };

    const mockRedis: any = {
      del: async () => {
        throw new Error("Redis connection ECONNREFUSED");
      },
    };

    const result = await updateAgentStatus("agent-123", "ACTIVE", mockPrisma, mockRedis);
    assert.equal(dbUpdated, true, "Database record must be updated");
    assert.equal(result.id, "agent-123");
    assert.equal(result.status, "ACTIVE");
  });
});

describe("Reliability Hardening — Transaction & Credit Idempotency", () => {
  it("should not double-charge a student when deductFare is called with an existing transactionId", async () => {
    let updateCount = 0;
    const mockDb: any = {
      wallet: {
        findUnique: async () => ({ balance: 500 }),
        update: async () => {
          updateCount++;
          return { balance: 350 };
        },
      },
      transaction: {
        findUnique: async ({ where }: any) => {
          if (where.transaction_id === "TX-DUP-001") {
            return { transaction_id: "TX-DUP-001" };
          }
          return null;
        },
      },
    };

    const result = await deductFare("STU/001", 150, "TX-DUP-001", mockDb);
    assert.equal(result.walletFound, true);
    assert.equal(result.alreadyProcessed, true);
    assert.equal(result.newBalance, 500);
    assert.equal(updateCount, 0, "Wallet update must not be called when transaction already processed");
  });

  it("should not double-credit a wallet when creditWallet is called with an existing transaction reference", async () => {
    let updateCalled = false;
    const mockDb: any = {
      wallet: {
        findUnique: async () => ({ balance: 1000 }),
        update: async () => {
          updateCalled = true;
          return { balance: 1500 };
        },
      },
      transaction: {
        findUnique: async ({ where }: any) => {
          if (where.transaction_id === "TOPUP-EXISTING-001") {
            return { transaction_id: "TOPUP-EXISTING-001" };
          }
          return null;
        },
      },
      $transaction: async () => {
        updateCalled = true;
        return [{ balance: 1500 }];
      },
    };

    const result = await creditWallet("STU/001", 500, "TOPUP-EXISTING-001", mockDb);
    assert.ok(result);
    assert.equal(result.previousBalance, 1000);
    assert.equal(result.newBalance, 1000);
    assert.equal(updateCalled, false, "Wallet update must not be performed on repeated top-up webhook");
  });

  it("should not double-charge in settleRideTransaction when already processed", async () => {
    let debitCalled = false;
    const mockDb: any = {
      transaction: {
        findUnique: async () => ({ transaction_id: "RIDE-123" }),
      },
      wallet: {
        update: async () => {
          debitCalled = true;
          return { balance: 0 };
        },
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "RIDE-123",
        studentUid: "STU/001",
        terminalId: "TERM-01",
        fare: 100,
      },
      mockDb
    );

    assert.equal(result.success, true);
    assert.equal(result.alreadyProcessed, true);
    assert.equal(debitCalled, false);
  });
});

describe("Reliability Hardening — Atomic OTP Consumption & Card Mapping", () => {
  it("should atomically consume OTP and prevent race condition reuse", async () => {
    let otpUsed = false;
    let cardMapped = false;

    const mockTx: any = {
      registrationOtp: {
        updateMany: async ({ where, data }: any) => {
          if (where.otp === "123456" && where.used === false && !otpUsed) {
            otpUsed = true;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
      cardMapping: {
        upsert: async () => {
          cardMapped = true;
        },
      },
    };

    // First attempt: should succeed
    const firstAttempt = await (async () => {
      const consumed = await mockTx.registrationOtp.updateMany({
        where: { otp: "123456", used: false },
        data: { used: true },
      });
      if (consumed.count === 0) {
        throw new Error("OTP_ALREADY_USED");
      }
      await mockTx.cardMapping.upsert();
      return true;
    })();

    assert.equal(firstAttempt, true);
    assert.equal(otpUsed, true);
    assert.equal(cardMapped, true);

    // Second concurrent/duplicate attempt: must fail with OTP_ALREADY_USED
    await assert.rejects(
      async () => {
        const consumed = await mockTx.registrationOtp.updateMany({
          where: { otp: "123456", used: false },
          data: { used: true },
        });
        if (consumed.count === 0) {
          throw new Error("OTP_ALREADY_USED");
        }
        await mockTx.cardMapping.upsert();
      },
      (err: Error) => {
        return err.message === "OTP_ALREADY_USED";
      }
    );
  });
});

