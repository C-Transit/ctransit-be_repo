import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settleRideTransaction } from "../src/services/ledger.service.js";
import { createDriverWithdrawal } from "../src/services/driver.service.js";

/**
 * In-memory transactional DB simulating PostgreSQL's row-level locking
 * and read-committed isolation under concurrency.
 */
function createConcurrentMockDb(initialState: {
  studentBalance?: number;
  driverBalance?: number;
  systemBalance?: number;
  driverUser?: {
    id: string;
    matricNumber: string;
    email: string;
    bankCode?: string;
    bankName?: string;
    accountNumber?: string;
    accountName?: string;
    bankVerified?: boolean;
  };
}) {
  let studentBalance = initialState.studentBalance ?? 150;
  let driverBalance = initialState.driverBalance ?? 0;
  let driverTotalEarnings = initialState.driverBalance ?? 0;
  let systemBalance = initialState.systemBalance ?? 0;
  let systemRevenue = initialState.systemBalance ?? 0;

  const transactions = new Map<string, any>();
  const withdrawals = new Map<string, any>();
  const users = new Map<string, any>();

  if (initialState.driverUser) {
    users.set(initialState.driverUser.id, initialState.driverUser);
    users.set(initialState.driverUser.matricNumber, initialState.driverUser);
  }

  // Mutex lock to simulate transactional row-level isolation
  let txLock = Promise.resolve();
  const acquireLock = () => {
    let release: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = txLock;
    txLock = prev.then(() => wait);
    return prev.then(() => release);
  };

  const db: any = {
    getState: () => ({
      studentBalance,
      driverBalance,
      driverTotalEarnings,
      systemBalance,
      systemRevenue,
      transactions: Array.from(transactions.values()),
      withdrawals: Array.from(withdrawals.values()),
    }),

    transaction: {
      findUnique: async ({ where }: any) => {
        return transactions.get(where.transaction_id) || null;
      },
      create: async ({ data }: any) => {
        if (transactions.has(data.transaction_id)) {
          const err: any = new Error("Unique constraint failed on the fields: (`transaction_id`)");
          err.code = "P2002";
          throw err;
        }
        transactions.set(data.transaction_id, data);
        return data;
      },
    },

    wallet: {
      findUnique: async ({ where }: any) => {
        return { student_uid: where.student_uid, balance: studentBalance };
      },
      updateMany: async ({ where, data }: any) => {
        const required = where?.balance?.gte ?? 0;
        if (studentBalance >= required) {
          studentBalance -= data.balance.decrement;
          return { count: 1 };
        }
        return { count: 0 };
      },
      update: async ({ data }: any) => {
        studentBalance -= data.balance.decrement;
        return { balance: studentBalance };
      },
    },

    driverWallet: {
      findUnique: async ({ where }: any) => {
        return { driver_uid: where.driver_uid, balance: driverBalance };
      },
      updateMany: async ({ where, data }: any) => {
        const required = where?.balance?.gte ?? 0;
        if (driverBalance >= required) {
          driverBalance -= data.balance.decrement;
          return { count: 1 };
        }
        return { count: 0 };
      },
      update: async ({ data }: any) => {
        if (data.balance?.decrement) {
          driverBalance -= data.balance.decrement;
        }
        if (data.balance?.increment) {
          driverBalance += data.balance.increment;
        }
        return { balance: driverBalance };
      },
      upsert: async ({ create, update }: any) => {
        const inc = update?.balance?.increment ?? create?.balance ?? 0;
        driverBalance += inc;
        driverTotalEarnings += inc;
        return { balance: driverBalance, total_earnings: driverTotalEarnings };
      },
    },

    systemWallet: {
      upsert: async ({ create, update }: any) => {
        const inc = update?.balance?.increment ?? create?.balance ?? 0;
        systemBalance += inc;
        systemRevenue += inc;
        return { balance: systemBalance, total_revenue: systemRevenue };
      },
    },

    user: {
      findUnique: async ({ where }: any) => {
        return users.get(where.id || where.matricNumber) || null;
      },
      update: async () => ({}),
    },

    driverWithdrawal: {
      findUnique: async ({ where }: any) => {
        return withdrawals.get(where.id) || null;
      },
      create: async ({ data }: any) => {
        const id = `wdr-id-${withdrawals.size + 1}`;
        const record = { id, ...data };
        withdrawals.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = withdrawals.get(where.id) || {};
        const updated = { ...existing, ...data };
        withdrawals.set(where.id, updated);
        return updated;
      },
    },

    $transaction: async (callback: any) => {
      // Simulate ACID transaction with row-level serialization
      const release = await acquireLock();
      try {
        return await callback(db);
      } finally {
        release();
      }
    },
  };

  return db;
}

describe("C-Transit — Final Financial Concurrency Verification", () => {
  it("should handle TWO concurrent ride transactions costing ₦150 when student balance is ₦150", async () => {
    const mockDb = createConcurrentMockDb({
      studentBalance: 150,
      driverBalance: 0,
      systemBalance: 0,
      driverUser: {
        id: "driver-uuid-1",
        matricNumber: "DRV/2026/001",
        email: "driver1@ctransit.me",
        bankCode: "044",
        bankName: "Access Bank",
        accountNumber: "0123456789",
        accountName: "Driver One",
        bankVerified: true,
      },
    });

    const txA = {
      transactionId: "TX-RIDE-CONCUR-A",
      studentUid: "STU/2026/001",
      terminalId: "TERM-01",
      fare: 150,
      driverUid: "DRV/2026/001",
    };

    const txB = {
      transactionId: "TX-RIDE-CONCUR-B",
      studentUid: "STU/2026/001",
      terminalId: "TERM-01",
      fare: 150,
      driverUid: "DRV/2026/001",
    };

    // Submit TWO different valid ride transactions concurrently
    const [resultA, resultB] = await Promise.all([
      settleRideTransaction(txA, mockDb),
      settleRideTransaction(txB, mockDb),
    ]);

    const results = [resultA, resultB];
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // Exactly ONE must succeed
    assert.equal(successes.length, 1, "Exactly one transaction must succeed");
    assert.equal(successes[0].studentBalance, 0, "Successful transaction leaves student balance at 0");
    assert.equal(successes[0].driverBalance, 144, "Driver must receive exactly ₦144 (96%)");
    assert.equal(successes[0].ctransitBalance, 6, "C-Transit must receive exactly ₦6 (4%)");

    // Exactly ONE must fail with insufficient balance
    assert.equal(failures.length, 1, "Exactly one transaction must fail");
    assert.equal(failures[0].insufficientFunds, true, "Failed transaction must flag insufficient funds");
    assert.equal(failures[0].error, "INSUFFICIENT_FUNDS", "Failed transaction error must be INSUFFICIENT_FUNDS");

    // Check final database state
    const state = mockDb.getState();

    // Final student balance must be ₦0
    assert.equal(state.studentBalance, 0, "Final student balance must be exactly ₦0");

    // Driver must receive exactly ₦144
    assert.equal(state.driverBalance, 144, "Driver must receive exactly ₦144");
    assert.equal(state.driverTotalEarnings, 144, "Driver total earnings must equal ₦144");

    // C-Transit must receive exactly ₦6
    assert.equal(state.systemBalance, 6, "C-Transit must receive exactly ₦6");
    assert.equal(state.systemRevenue, 6, "C-Transit revenue must equal ₦6");

    // No negative balance
    assert.ok(state.studentBalance >= 0, "Student balance must not be negative");
    assert.ok(state.driverBalance >= 0, "Driver balance must not be negative");

    // No partial transaction state: exactly one transaction record in database
    assert.equal(state.transactions.length, 1, "Only one transaction audit record must exist");
    assert.equal(state.transactions[0].amount, 150);
    assert.equal(state.transactions[0].driver_share, 144);
    assert.equal(state.transactions[0].ctransit_share, 6);
  });

  it("should ensure only ONE financial settlement when the exact same transaction is submitted concurrently twice", async () => {
    const mockDb = createConcurrentMockDb({
      studentBalance: 300,
      driverBalance: 0,
      systemBalance: 0,
      driverUser: {
        id: "driver-uuid-1",
        matricNumber: "DRV/2026/001",
        email: "driver1@ctransit.me",
      },
    });

    const identicalTx = {
      transactionId: "TX-SAME-CONCUR-001",
      studentUid: "STU/2026/001",
      terminalId: "TERM-01",
      fare: 150,
      driverUid: "DRV/2026/001",
    };

    // Submit the EXACT same transaction twice concurrently
    const [res1, res2] = await Promise.all([
      settleRideTransaction(identicalTx, mockDb),
      settleRideTransaction(identicalTx, mockDb),
    ]);

    // Both should report success (one newly settled, one detected as already settled)
    assert.equal(res1.success, true);
    assert.equal(res2.success, true);

    const hasAlreadyProcessed = res1.alreadyProcessed || res2.alreadyProcessed;
    assert.equal(hasAlreadyProcessed, true, "At least one call must detect alreadyProcessed");

    // Crucial financial invariant: only ONE financial debit and credit occurred!
    const state = mockDb.getState();
    assert.equal(state.studentBalance, 150, "Student must be debited exactly once (300 - 150 = 150)");
    assert.equal(state.driverBalance, 144, "Driver must be credited exactly once (₦144)");
    assert.equal(state.systemBalance, 6, "C-Transit must be credited exactly once (₦6)");
    assert.equal(state.transactions.length, 1, "Only one audit transaction record must be created");
  });

  it("should ensure concurrent driver withdrawals cannot exceed driver balance", async () => {
    const driverUser = {
      id: "drv-user-1",
      matricNumber: "DRV/2026/999",
      firstname: "Tunde",
      lastname: "Driver",
      role: "DRIVER",
      email: "tunde@ctransit.me",
      bankName: "Access Bank",
      accountNumber: "0123456789",
      accountName: "Tunde Driver",
      bankCode: "044",
      bankVerified: true,
    };

    const mockDb = createConcurrentMockDb({
      driverBalance: 10000,
      driverUser,
    });

    const mockGateway: any = {
      initiatePayout: async () => ({
        status: "processing",
        koraReference: "KORA-REF-1",
      }),
    };

    // Driver has ₦10,000 balance. Driver submits TWO concurrent withdrawal requests for ₦10,000 each.
    const results = await Promise.allSettled([
      createDriverWithdrawal(driverUser.id, { amount: 10000, remarks: "First withdrawal" }, mockDb, mockGateway),
      createDriverWithdrawal(driverUser.id, { amount: 10000, remarks: "Second withdrawal" }, mockDb, mockGateway),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly ONE must succeed, and ONE must be rejected with INSUFFICIENT_BALANCE
    assert.equal(fulfilled.length, 1, "Exactly one withdrawal of ₦10,000 must succeed");
    assert.equal(rejected.length, 1, "Exactly one withdrawal must fail");

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    assert.equal(
      rejectionReason?.message,
      "INSUFFICIENT_BALANCE",
      "Rejected error must be INSUFFICIENT_BALANCE"
    );

    // Verify driver balance: must be exactly 0, never negative!
    const state = mockDb.getState();
    assert.equal(state.driverBalance, 0, "Final driver balance must be ₦0 and never negative");
    assert.equal(state.withdrawals.length, 1, "Only one withdrawal record must be created");
  });
});
