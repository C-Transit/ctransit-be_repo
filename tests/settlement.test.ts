import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateFareSplit,
  DRIVER_SPLIT_RATIO,
  CTRANSIT_SPLIT_RATIO,
  settleRideTransaction,
  deductFare,
} from "../src/services/ledger.service.js";

describe("Ride Settlement — Split Calculations", () => {
  it("should enforce 96% driver and 4% C-Transit ratios", () => {
    assert.equal(DRIVER_SPLIT_RATIO, 0.96);
    assert.equal(CTRANSIT_SPLIT_RATIO, 0.04);
  });

  it("should split standard fares correctly", () => {
    // 100 Naira fare
    const split100 = calculateFareSplit(100);
    assert.equal(split100.fare, 100);
    assert.equal(split100.driverShare, 96);
    assert.equal(split100.ctransitShare, 4);
    assert.equal(split100.driverShare + split100.ctransitShare, 100);

    // 150 Naira fare (typical campus transit fare)
    const split150 = calculateFareSplit(150);
    assert.equal(split150.fare, 150);
    assert.equal(split150.driverShare, 144);
    assert.equal(split150.ctransitShare, 6);
    assert.equal(split150.driverShare + split150.ctransitShare, 150);

    // 250 Naira fare
    const split250 = calculateFareSplit(250);
    assert.equal(split250.fare, 250);
    assert.equal(split250.driverShare, 240);
    assert.equal(split250.ctransitShare, 10);
    assert.equal(split250.driverShare + split250.ctransitShare, 250);
  });

  it("should guarantee exact penny parity with decimal fares without rounding loss", () => {
    const oddFares = [35.5, 77.25, 123.45, 99.99, 15.33];
    for (const fare of oddFares) {
      const split = calculateFareSplit(fare);
      const sum = Math.round((split.driverShare + split.ctransitShare) * 100) / 100;
      assert.equal(sum, fare, `Sum ${sum} must exactly equal fare ${fare}`);
    }
  });
});

describe("Deduct Fare — Negative Balance Prevention", () => {
  it("should prevent deduction when student balance is lower than amount", async () => {
    let updateCalled = false;
    const mockDb: any = {
      wallet: {
        findUnique: async () => ({ balance: 50 }),
        update: async () => {
          updateCalled = true;
          return { balance: 0 };
        },
      },
    };

    const result = await deductFare("STU/001", 100, "TX-1", mockDb);
    assert.equal(result.walletFound, true);
    assert.equal(result.insufficientFunds, true);
    assert.equal(result.newBalance, 50);
    assert.equal(updateCalled, false, "Database update must not be called when funds are insufficient");
  });

  it("should deduct successfully when student has sufficient balance", async () => {
    const mockDb: any = {
      wallet: {
        findUnique: async () => ({ balance: 200 }),
        update: async ({ data }: any) => ({
          balance: 200 - data.balance.decrement,
        }),
      },
    };

    const result = await deductFare("STU/001", 150, "TX-2", mockDb);
    assert.equal(result.walletFound, true);
    assert.equal(result.insufficientFunds, undefined);
    assert.equal(result.newBalance, 50);
  });
});

describe("Atomic Ride Settlement Service", () => {
  it("should preserve idempotency when transaction already exists", async () => {
    const existingTx = {
      transaction_id: "TX-EXISTING-001",
      amount: 150,
      student_uid: "STU/001",
    };

    const mockDb: any = {
      transaction: {
        findUnique: async () => existingTx,
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-EXISTING-001",
        studentUid: "STU/001",
        terminalId: "TERM-01",
        fare: 150,
      },
      mockDb
    );

    assert.equal(result.success, true);
    assert.equal(result.alreadyProcessed, true);
    assert.deepEqual(result.transaction, existingTx);
  });

  it("should reject settlement when student wallet has insufficient balance", async () => {
    const mockDb: any = {
      transaction: {
        findUnique: async () => null,
      },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null },
          wallet: {
            findUnique: async () => ({ balance: 30 }),
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-NEW-001",
        studentUid: "STU/001",
        terminalId: "TERM-01",
        fare: 150,
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.insufficientFunds, true);
    assert.equal(result.error, "INSUFFICIENT_FUNDS");
  });

  it("should atomically debit student, credit driver (96%), credit C-Transit (4%), and record transaction", async () => {
    let studentDebited = 0;
    let driverCredited = 0;
    let ctransitCredited = 0;
    let createdTransaction: any = null;

    const mockDb: any = {
      transaction: {
        findUnique: async () => null,
      },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: {
            findUnique: async () => null,
            create: async ({ data }: any) => {
              createdTransaction = data;
              return data;
            },
          },
          wallet: {
            findUnique: async () => ({ balance: 500 }),
            update: async ({ data }: any) => {
              studentDebited = data.balance.decrement;
              return { balance: 500 - studentDebited };
            },
          },
          user: {
            findUnique: async () => ({ id: "driver-id-1" }),
          },
          driverWallet: {
            upsert: async ({ create, update }: any) => {
              driverCredited = update?.balance?.increment ?? create?.balance;
              return { balance: driverCredited, total_earnings: driverCredited };
            },
          },
          systemWallet: {
            upsert: async ({ create, update }: any) => {
              ctransitCredited = update?.balance?.increment ?? create?.balance;
              return { balance: ctransitCredited, total_revenue: ctransitCredited };
            },
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-RIDE-999",
        studentUid: "STU/12345",
        terminalId: "TERM-A",
        fare: 150,
        driverUid: "DRV/001",
      },
      mockDb
    );

    assert.equal(result.success, true);
    assert.equal(studentDebited, 150, "Student must be debited the full fare");
    assert.equal(driverCredited, 144, "Driver must be credited 96% of 150");
    assert.equal(ctransitCredited, 6, "C-Transit must be credited 4% of 150");

    assert.equal(result.studentBalance, 350);
    assert.equal(result.driverBalance, 144);
    assert.equal(result.ctransitBalance, 6);

    assert.ok(createdTransaction, "Transaction record must be created");
    assert.equal(createdTransaction.transaction_id, "TX-RIDE-999");
    assert.equal(createdTransaction.fare, 150);
    assert.equal(createdTransaction.driver_share, 144);
    assert.equal(createdTransaction.ctransit_share, 6);
    assert.equal(createdTransaction.driver_uid, "DRV/001");
    assert.equal(createdTransaction.student_uid, "STU/12345");
  });
});
