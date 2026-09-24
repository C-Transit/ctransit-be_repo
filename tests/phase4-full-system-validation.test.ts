import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  settleRideTransaction,
  generateTransactionFingerprint,
} from "../src/services/ledger.service.js";
import {
  parseSingleTransaction,
  parseTransactionBatch,
} from "../src/utils/parser.js";

// ============================================================================
// TEST INFRASTRUCTURE: ACID-Compliant Transactional Mock Database (Section 14)
// ============================================================================

interface MockDbConfig {
  studentBalances?: Record<string, number>;
  driverBalances?: Record<string, number>;
  systemBalance?: number;
  users?: Array<{ id: string; matricNumber: string; role: string; email?: string }>;
  terminals?: Array<{ terminal_id: string; location?: string; active_driver_uid?: string | null }>;
  fareConfigs?: Array<{ code: string; location_code: string; amount: number; is_active: boolean }>;
  cardMappings?: Array<{ card_uid: string; student_uid: string; active?: boolean }>;
}

function createACIDMockDb(config: MockDbConfig = {}) {
  // Committed persistent state
  const studentWallets = new Map<string, number>();
  if (config.studentBalances) {
    for (const [sId, bal] of Object.entries(config.studentBalances)) {
      studentWallets.set(sId, bal);
    }
  }

  const driverWallets = new Map<string, { balance: number; total_earnings: number }>();
  if (config.driverBalances) {
    for (const [dId, bal] of Object.entries(config.driverBalances)) {
      driverWallets.set(dId, { balance: bal, total_earnings: bal });
    }
  }

  let systemBalance = config.systemBalance ?? 0;
  let systemRevenue = config.systemBalance ?? 0;

  const transactionsById = new Map<string, any>();
  const transactionsByIdemp = new Map<string, any>();

  const users = new Map<string, any>();
  (config.users || []).forEach((u) => {
    users.set(u.id, u);
    users.set(u.matricNumber, u);
  });

  const terminals = new Map<string, any>();
  (config.terminals || []).forEach((t) => {
    terminals.set(t.terminal_id, { ...t });
  });

  const fareConfigs = new Map<string, any>();
  (config.fareConfigs || []).forEach((f) => {
    fareConfigs.set(f.code.toUpperCase(), { ...f });
    fareConfigs.set(f.location_code.toUpperCase(), { ...f });
  });

  const cardMappings = new Map<string, any>();
  (config.cardMappings || []).forEach((c) => {
    cardMappings.set(c.card_uid.trim().toUpperCase(), { ...c });
  });

  // Mutex lock for transaction serialization (ACID isolation)
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

  const getSnapshotState = () => ({
    studentWallets: new Map(studentWallets),
    driverWallets: new Map(Array.from(driverWallets.entries()).map(([k, v]) => [k, { ...v }])),
    systemBalance,
    systemRevenue,
    transactions: Array.from(transactionsById.values()),
  });

  const db: any = {
    getState: getSnapshotState,

    cardMapping: {
      findUnique: async ({ where }: any) => {
        const uid = (where.card_uid || "").trim().toUpperCase();
        return cardMappings.get(uid) || null;
      },
      setMapping: (cardUid: string, studentUid: string) => {
        cardMappings.set(cardUid.trim().toUpperCase(), {
          card_uid: cardUid.trim().toUpperCase(),
          student_uid: studentUid,
          active: true,
        });
      },
    },

    terminal: {
      findUnique: async ({ where }: any) => {
        return terminals.get(where.terminal_id) || null;
      },
    },

    fareConfig: {
      findUnique: async ({ where }: any) => {
        const code = (where.code || where.location_code || "").trim().toUpperCase();
        return fareConfigs.get(code) || null;
      },
      findFirst: async ({ where }: any) => {
        const code = (where.code || where.location_code || "").trim().toUpperCase();
        return fareConfigs.get(code) || null;
      },
    },

    user: {
      findUnique: async ({ where }: any) => {
        return users.get(where.id || where.matricNumber) || null;
      },
    },

    transaction: {
      findUnique: async ({ where }: any) => {
        if (where.transaction_id) {
          return transactionsById.get(where.transaction_id) || null;
        }
        if (where.idempotency_key) {
          return transactionsByIdemp.get(where.idempotency_key) || null;
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        if (where.OR) {
          for (const cond of where.OR) {
            if (cond.transaction_id && transactionsById.has(cond.transaction_id)) {
              return transactionsById.get(cond.transaction_id);
            }
            if (cond.idempotency_key && transactionsByIdemp.has(cond.idempotency_key)) {
              return transactionsByIdemp.get(cond.idempotency_key);
            }
          }
        }
        return null;
      },
    },

    wallet: {
      findUnique: async ({ where }: any) => {
        const bal = studentWallets.get(where.student_uid);
        if (bal === undefined) return null;
        return { student_uid: where.student_uid, balance: bal };
      },
    },

    driverWallet: {
      findUnique: async ({ where }: any) => {
        const dw = driverWallets.get(where.driver_uid);
        if (!dw) return null;
        return { driver_uid: where.driver_uid, balance: dw.balance, total_earnings: dw.total_earnings };
      },
    },

    systemWallet: {
      findUnique: async () => ({
        id: "CTRANSIT_SYSTEM",
        balance: systemBalance,
        total_revenue: systemRevenue,
      }),
    },

    // Transaction execution with STAGED commit and FULL ROLLBACK on failure
    $transaction: async (callback: any) => {
      const release = await acquireLock();
      try {
        // Stage mutable copies for this atomic transaction
        const stagedStudent = new Map(studentWallets);
        const stagedDriver = new Map(
          Array.from(driverWallets.entries()).map(([k, v]) => [k, { ...v }])
        );
        let stagedSystemBal = systemBalance;
        let stagedSystemRev = systemRevenue;
        const stagedTxById = new Map(transactionsById);
        const stagedTxByIdemp = new Map(transactionsByIdemp);

        // Transaction client proxy
        const txClient: any = {
          cardMapping: db.cardMapping,
          terminal: db.terminal,
          fareConfig: db.fareConfig,
          user: db.user,

          transaction: {
            findUnique: async ({ where }: any) => {
              if (where.transaction_id) {
                return stagedTxById.get(where.transaction_id) || null;
              }
              if (where.idempotency_key) {
                return stagedTxByIdemp.get(where.idempotency_key) || null;
              }
              return null;
            },
            create: async ({ data }: any) => {
              if (stagedTxById.has(data.transaction_id)) {
                const err: any = new Error("Unique constraint failed on the fields: (`transaction_id`)");
                err.code = "P2002";
                throw err;
              }
              if (data.idempotency_key && stagedTxByIdemp.has(data.idempotency_key)) {
                const err: any = new Error("Unique constraint failed on the fields: (`idempotency_key`)");
                err.code = "P2002";
                throw err;
              }
              stagedTxById.set(data.transaction_id, data);
              if (data.idempotency_key) {
                stagedTxByIdemp.set(data.idempotency_key, data);
              }
              return data;
            },
          },

          wallet: {
            findUnique: async ({ where }: any) => {
              const bal = stagedStudent.get(where.student_uid);
              if (bal === undefined) return null;
              return { student_uid: where.student_uid, balance: bal };
            },
            updateMany: async ({ where, data }: any) => {
              const bal = stagedStudent.get(where.student_uid);
              if (bal === undefined) return { count: 0 };
              const required = where?.balance?.gte ?? 0;
              if (bal >= required) {
                stagedStudent.set(where.student_uid, bal - data.balance.decrement);
                return { count: 1 };
              }
              return { count: 0 };
            },
            update: async ({ where, data }: any) => {
              const bal = stagedStudent.get(where.student_uid) ?? 0;
              const newBal = bal - (data.balance?.decrement ?? 0);
              stagedStudent.set(where.student_uid, newBal);
              return { balance: newBal };
            },
          },

          driverWallet: {
            findUnique: async ({ where }: any) => {
              const dw = stagedDriver.get(where.driver_uid);
              if (!dw) return null;
              return { driver_uid: where.driver_uid, balance: dw.balance, total_earnings: dw.total_earnings };
            },
            upsert: async ({ where, create, update }: any) => {
              const dw = stagedDriver.get(where.driver_uid) || { balance: 0, total_earnings: 0 };
              const inc = update?.balance?.increment ?? create?.balance ?? 0;
              const newBal = dw.balance + inc;
              const newEarnings = dw.total_earnings + inc;
              const updated = { balance: newBal, total_earnings: newEarnings };
              stagedDriver.set(where.driver_uid, updated);
              return updated;
            },
          },

          systemWallet: {
            upsert: async ({ create, update }: any) => {
              const inc = update?.balance?.increment ?? create?.balance ?? 0;
              stagedSystemBal += inc;
              stagedSystemRev += inc;
              return { balance: stagedSystemBal, total_revenue: stagedSystemRev };
            },
          },
        };

        // Execute transaction callback
        const result = await callback(txClient);

        // Commit staged mutations only if transaction succeeded
        for (const [sId, bal] of stagedStudent.entries()) {
          studentWallets.set(sId, bal);
        }
        for (const [dId, dw] of stagedDriver.entries()) {
          driverWallets.set(dId, dw);
        }
        systemBalance = stagedSystemBal;
        systemRevenue = stagedSystemRev;
        for (const [id, tx] of stagedTxById.entries()) {
          transactionsById.set(id, tx);
        }
        for (const [k, tx] of stagedTxByIdemp.entries()) {
          transactionsByIdemp.set(k, tx);
        }

        return result;
      } finally {
        release();
      }
    },
  };

  return db;
}

// Global Invariant Verification Helper
function verifyFinancialInvariants(params: {
  initialStudentBalance: number;
  finalStudentBalance: number;
  initialDriverBalance: number;
  finalDriverBalance: number;
  initialSystemBalance: number;
  finalSystemBalance: number;
  totalDebited: number;
}) {
  const {
    initialStudentBalance,
    finalStudentBalance,
    initialDriverBalance,
    finalDriverBalance,
    initialSystemBalance,
    finalSystemBalance,
    totalDebited,
  } = params;

  // Invariant 1: Total money conservation
  const initialTotal = initialStudentBalance + initialDriverBalance + initialSystemBalance;
  const finalTotal = finalStudentBalance + finalDriverBalance + finalSystemBalance;
  assert.equal(
    finalTotal,
    initialTotal,
    `Total system money must be strictly conserved: initial=${initialTotal}, final=${finalTotal}`
  );

  // Invariant 2: Student debit equals sum of driver credit and system credit
  const driverCredited = finalDriverBalance - initialDriverBalance;
  const systemCredited = finalSystemBalance - initialSystemBalance;
  assert.equal(
    driverCredited + systemCredited,
    totalDebited,
    `Driver credit (${driverCredited}) + System credit (${systemCredited}) must exactly equal student debit (${totalDebited})`
  );

  // Invariant 3: 96% / 4% split ratio
  if (totalDebited > 0) {
    const expectedDriver = Math.round(totalDebited * 0.96 * 100) / 100;
    const expectedSystem = Math.round((totalDebited - expectedDriver) * 100) / 100;
    assert.equal(driverCredited, expectedDriver, `Driver must receive 96% of debited funds`);
    assert.equal(systemCredited, expectedSystem, `System must receive 4% of debited funds`);
  }

  // Invariant 4: No negative balances
  assert.ok(finalStudentBalance >= 0, "Student balance must never be negative");
  assert.ok(finalDriverBalance >= 0, "Driver balance must never be negative");
  assert.ok(finalSystemBalance >= 0, "System balance must never be negative");
}

// ============================================================================
// PHASE 4 TEST SUITES
// ============================================================================

describe("C-Transit v1.1.0L — Phase 4: Full-System Validation & Failure Testing", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. END-TO-END FINANCIAL PATH (Section 1 & 12)
  // ──────────────────────────────────────────────────────────────────────────
  describe("1. End-to-End Financial Path & Audit Integrity", () => {
    it("should process v1.1.0L payload from raw terminal string through full settlement and produce complete audit", async () => {
      const db = createACIDMockDb({
        studentBalances: { "2022/1/87453LH": 500 },
        driverBalances: { "DRV-83": 0 },
        systemBalance: 0,
        users: [{ id: "usr-drv-83", matricNumber: "DRV-83", role: "DRIVER" }],
        terminals: [{ terminal_id: "9AF7F0", location: "A", active_driver_uid: "DRV-83" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "238DB4E8", student_uid: "2022/1/87453LH" }],
      });

      // Terminal raw input: 9AF7F0:238DB4E8,-150,1784485554,83,A
      const rawLine = "9AF7F0:238DB4E8,-150,1784485554,83,A";
      const parseResult = parseSingleTransaction(rawLine, "9AF7F0");

      assert.equal(parseResult.error, undefined);
      assert.ok(parseResult.data);
      const parsed = parseResult.data!;

      assert.equal(parsed.terminal_id, "9AF7F0");
      assert.equal(parsed.student_uid, "238DB4E8"); // Physical NFC Card UID
      assert.equal(parsed.card_uid, "238DB4E8");
      assert.equal(parsed.amount, 150);
      assert.equal(parsed.location, "A");
      assert.equal(parsed.driver_uid, "83");
      assert.equal(parsed.timestamp, 1784485554);
      assert.ok(parsed.tapped_at instanceof Date);
      assert.ok(parsed.synced_at instanceof Date);

      // Ingestion time is distinct from terminal tap time
      assert.notEqual(parsed.tapped_at?.getTime(), parsed.synced_at?.getTime());

      // Settle through backend financial entrypoint
      const settleResult = await settleRideTransaction(
        {
          studentUid: parsed.student_uid,
          cardUid: parsed.card_uid,
          terminalId: parsed.terminal_id,
          fare: parsed.amount,
          driverUid: "DRV-83", // Normalised driver matric
          location: parsed.location || undefined,
          timestamp: parsed.timestamp,
          tappedAt: parsed.tapped_at,
          syncedAt: parsed.synced_at,
          protocolVersion: "v1.1.0L",
        },
        db
      );

      assert.equal(settleResult.success, true);
      assert.equal(settleResult.studentBalance, 350);
      assert.equal(settleResult.driverBalance, 144);
      assert.equal(settleResult.ctransitBalance, 6);

      // Verify transaction audit record
      const txRecord = settleResult.transaction;
      assert.ok(txRecord);
      assert.equal(txRecord.type, "RIDE");
      assert.equal(txRecord.student_uid, "2022/1/87453LH"); // Resolved student matric
      assert.equal(txRecord.card_uid, "238DB4E8"); // Raw physical NFC card UID retained
      assert.equal(txRecord.driver_uid, "DRV-83");
      assert.equal(txRecord.terminal_id, "9AF7F0");
      assert.equal(txRecord.location, "A");
      assert.equal(txRecord.amount, 150);
      assert.equal(txRecord.driver_share, 144);
      assert.equal(txRecord.ctransit_share, 6);
      assert.ok(txRecord.idempotency_key);
      assert.ok(txRecord.tapped_at instanceof Date);
      assert.ok(txRecord.synced_at instanceof Date);

      const state = db.getState();
      verifyFinancialInvariants({
        initialStudentBalance: 500,
        finalStudentBalance: state.studentWallets.get("2022/1/87453LH")!,
        initialDriverBalance: 0,
        finalDriverBalance: state.driverWallets.get("DRV-83")!.balance,
        initialSystemBalance: 0,
        finalSystemBalance: state.systemBalance,
        totalDebited: 150,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. FINANCIAL CONCURRENCY TESTS (Section 2)
  // ──────────────────────────────────────────────────────────────────────────
  describe("2. Financial Concurrency Tests", () => {
    it("A. Student has ₦150. Two simultaneous ₦150 rides: exactly one succeeds, one fails INSUFFICIENT_FUNDS", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-CONCUR-1": 150 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-C1", student_uid: "STU-CONCUR-1" }],
      });

      const ride1 = {
        cardUid: "CARD-C1",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784480001,
        protocolVersion: "v1.1.0L",
      };

      const ride2 = {
        cardUid: "CARD-C1",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784480002, // Different timestamp = different ride
        protocolVersion: "v1.1.0L",
      };

      const [res1, res2] = await Promise.all([
        settleRideTransaction(ride1, db),
        settleRideTransaction(ride2, db),
      ]);

      const successes = [res1, res2].filter((r) => r.success);
      const failures = [res1, res2].filter((r) => !r.success);

      assert.equal(successes.length, 1, "Exactly one ride must succeed");
      assert.equal(failures.length, 1, "Exactly one ride must fail");
      assert.equal(failures[0].error, "INSUFFICIENT_FUNDS");

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-CONCUR-1"), 0);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 144);
      assert.equal(state.systemBalance, 6);
      assert.equal(state.transactions.length, 1);

      verifyFinancialInvariants({
        initialStudentBalance: 150,
        finalStudentBalance: state.studentWallets.get("STU-CONCUR-1")!,
        initialDriverBalance: 0,
        finalDriverBalance: state.driverWallets.get("DRV-1")!.balance,
        initialSystemBalance: 0,
        finalSystemBalance: state.systemBalance,
        totalDebited: 150,
      });
    });

    it("B. Student has ₦300. Two simultaneous ₦150 rides: both succeed, balance = ₦0", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-CONCUR-2": 300 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-C2", student_uid: "STU-CONCUR-2" }],
      });

      const ride1 = {
        cardUid: "CARD-C2",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784481001,
        protocolVersion: "v1.1.0L",
      };

      const ride2 = {
        cardUid: "CARD-C2",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784481002,
        protocolVersion: "v1.1.0L",
      };

      const [res1, res2] = await Promise.all([
        settleRideTransaction(ride1, db),
        settleRideTransaction(ride2, db),
      ]);

      assert.equal(res1.success, true);
      assert.equal(res2.success, true);

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-CONCUR-2"), 0);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 288);
      assert.equal(state.systemBalance, 12);
      assert.equal(state.transactions.length, 2);

      verifyFinancialInvariants({
        initialStudentBalance: 300,
        finalStudentBalance: state.studentWallets.get("STU-CONCUR-2")!,
        initialDriverBalance: 0,
        finalDriverBalance: state.driverWallets.get("DRV-1")!.balance,
        initialSystemBalance: 0,
        finalSystemBalance: state.systemBalance,
        totalDebited: 300,
      });
    });

    it("C. Multiple simultaneous rides (5x ₦150) against same student with ₦300 balance: no negative balance, no partial settlement", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-CONCUR-5": 300 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-C5", student_uid: "STU-CONCUR-5" }],
      });

      const promises = Array.from({ length: 5 }).map((_, i) =>
        settleRideTransaction(
          {
            cardUid: "CARD-C5",
            terminalId: "TERM-1",
            fare: 150,
            driverUid: "DRV-1",
            location: "A",
            timestamp: 1784482000 + i,
            protocolVersion: "v1.1.0L",
          },
          db
        )
      );

      const results = await Promise.all(promises);
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      assert.equal(successes.length, 2, "Exactly 2 of 5 rides must succeed");
      assert.equal(failures.length, 3, "Exactly 3 of 5 rides must fail");
      for (const f of failures) {
        assert.equal(f.error, "INSUFFICIENT_FUNDS");
      }

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-CONCUR-5"), 0);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 288);
      assert.equal(state.systemBalance, 12);
      assert.equal(state.transactions.length, 2);

      verifyFinancialInvariants({
        initialStudentBalance: 300,
        finalStudentBalance: state.studentWallets.get("STU-CONCUR-5")!,
        initialDriverBalance: 0,
        finalDriverBalance: state.driverWallets.get("DRV-1")!.balance,
        initialSystemBalance: 0,
        finalSystemBalance: state.systemBalance,
        totalDebited: 300,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. IDEMPOTENCY & DUPLICATE DELIVERY (Section 3)
  // ──────────────────────────────────────────────────────────────────────────
  describe("3. Idempotency & Delivery Resilience", () => {
    it("should handle the same exact v1.1.0L payload twice sequentially with zero duplicate debit", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-IDEMP-1": 500 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-IDEMP-1", student_uid: "STU-IDEMP-1" }],
      });

      const payload = {
        cardUid: "CARD-IDEMP-1",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784483000,
        rawAmount: "-150",
        protocolVersion: "v1.1.0L",
      };

      const res1 = await settleRideTransaction(payload, db);
      assert.equal(res1.success, true);
      assert.equal(res1.studentBalance, 350);

      const res2 = await settleRideTransaction(payload, db);
      assert.equal(res2.success, true);
      assert.equal(res2.alreadyProcessed, true);

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-IDEMP-1"), 350);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 144);
      assert.equal(state.systemBalance, 6);
      assert.equal(state.transactions.length, 1);

      verifyFinancialInvariants({
        initialStudentBalance: 500,
        finalStudentBalance: 350,
        initialDriverBalance: 0,
        finalDriverBalance: 144,
        initialSystemBalance: 0,
        finalSystemBalance: 6,
        totalDebited: 150,
      });
    });

    it("should handle the same exact v1.1.0L payload 5 times sequentially without extra deductions", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-IDEMP-5": 500 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-IDEMP-5", student_uid: "STU-IDEMP-5" }],
      });

      const payload = {
        cardUid: "CARD-IDEMP-5",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784483500,
        protocolVersion: "v1.1.0L",
      };

      for (let i = 0; i < 5; i++) {
        const res = await settleRideTransaction(payload, db);
        assert.equal(res.success, true);
        if (i > 0) {
          assert.equal(res.alreadyProcessed, true);
        }
      }

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-IDEMP-5"), 350);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 144);
      assert.equal(state.systemBalance, 6);
      assert.equal(state.transactions.length, 1);
    });

    it("should handle the same exact v1.1.0L payload concurrently from multiple requests", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-IDEMP-CONCUR": 500 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-IDEMP-CONCUR", student_uid: "STU-IDEMP-CONCUR" }],
      });

      const payload = {
        cardUid: "CARD-IDEMP-CONCUR",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784483800,
        protocolVersion: "v1.1.0L",
      };

      const [res1, res2, res3] = await Promise.all([
        settleRideTransaction(payload, db),
        settleRideTransaction(payload, db),
        settleRideTransaction(payload, db),
      ]);

      assert.equal(res1.success, true);
      assert.equal(res2.success, true);
      assert.equal(res3.success, true);

      const alreadyProcessedCount = [res1, res2, res3].filter((r) => r.alreadyProcessed).length;
      assert.equal(alreadyProcessedCount >= 1, true, "At least one request was flagged as duplicate skip");

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-IDEMP-CONCUR"), 350);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 144);
      assert.equal(state.systemBalance, 6);
      assert.equal(state.transactions.length, 1);
    });

    it("should treat rides with same student and amount but different timestamp as separate legitimate transactions", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-DIFF-TS": 1000 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-DIFF-TS", student_uid: "STU-DIFF-TS" }],
      });

      const res1 = await settleRideTransaction(
        {
          cardUid: "CARD-DIFF-TS",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784484001,
          protocolVersion: "v1.1.0L",
        },
        db
      );

      const res2 = await settleRideTransaction(
        {
          cardUid: "CARD-DIFF-TS",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784484002, // 1 second later
          protocolVersion: "v1.1.0L",
        },
        db
      );

      assert.equal(res1.success, true);
      assert.equal(res2.success, true);
      assert.equal(res1.alreadyProcessed, undefined);
      assert.equal(res2.alreadyProcessed, undefined);

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-DIFF-TS"), 700);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 288);
      assert.equal(state.systemBalance, 12);
      assert.equal(state.transactions.length, 2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. CARD MAPPING INTEGRITY (Section 4)
  // ──────────────────────────────────────────────────────────────────────────
  describe("4. Card Mapping Integrity", () => {
    it("should reject unmapped card UID with CARD_NOT_MAPPED and perform ZERO financial mutation", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-GHOST": 500 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [], // Empty mappings
      });

      const res = await settleRideTransaction(
        {
          cardUid: "UNMAPPED_CARD_HEX",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784485000,
          protocolVersion: "v1.1.0L",
        },
        db
      );

      assert.equal(res.success, false);
      assert.equal(res.error, "CARD_NOT_MAPPED");
      assert.equal(res.rejectionReason, "CARD_NOT_MAPPED");

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-GHOST"), 500);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 0);
      assert.equal(state.systemBalance, 0);
      assert.equal(state.transactions.length, 0);
    });

    it("should debit the newly mapped student when a card is remapped", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-ORIGINAL": 500, "STU-NEW": 500 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-SWAP", student_uid: "STU-ORIGINAL" }],
      });

      // First ride debits STU-ORIGINAL
      const res1 = await settleRideTransaction(
        {
          cardUid: "CARD-SWAP",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784485100,
          protocolVersion: "v1.1.0L",
        },
        db
      );
      assert.equal(res1.success, true);
      assert.equal(db.getState().studentWallets.get("STU-ORIGINAL"), 350);

      // Admin remaps card to STU-NEW
      db.cardMapping.setMapping("CARD-SWAP", "STU-NEW");

      // Second ride must debit STU-NEW, not STU-ORIGINAL
      const res2 = await settleRideTransaction(
        {
          cardUid: "CARD-SWAP",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784485200,
          protocolVersion: "v1.1.0L",
        },
        db
      );
      assert.equal(res2.success, true);
      assert.equal(db.getState().studentWallets.get("STU-ORIGINAL"), 350); // Unchanged
      assert.equal(db.getState().studentWallets.get("STU-NEW"), 350); // Debited
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. DRIVER AUTHORIZATION (Section 5)
  // ──────────────────────────────────────────────────────────────────────────
  describe("5. Driver Authorization & Terminal Assignment", () => {
    it("should accept valid driver matching terminal assignment", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-1": 500 },
        driverBalances: { "DRV-AUTH-1": 0 },
        users: [{ id: "u-drv-1", matricNumber: "DRV-AUTH-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-AUTH-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-1", student_uid: "STU-1" }],
      });

      const res = await settleRideTransaction(
        {
          cardUid: "CARD-1",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-AUTH-1",
          location: "A",
          timestamp: 1784486000,
          protocolVersion: "v1.1.0L",
        },
        db
      );
      assert.equal(res.success, true);
      assert.equal(db.getState().driverWallets.get("DRV-AUTH-1")!.balance, 144);
    });

    it("should reject unknown driver with DRIVER_NOT_FOUND and zero earnings", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-1": 500 },
        driverBalances: {},
        users: [], // No user in table
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-UNKNOWN" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-1", student_uid: "STU-1" }],
      });

      const res = await settleRideTransaction(
        {
          cardUid: "CARD-1",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-UNKNOWN",
          location: "A",
          timestamp: 1784486001,
          protocolVersion: "v1.1.0L",
        },
        db
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "DRIVER_NOT_FOUND");
      assert.equal(db.getState().studentWallets.get("STU-1"), 500);
    });

    it("should reject non-DRIVER user with DRIVER_NOT_AUTHORIZED and zero earnings", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-1": 500 },
        driverBalances: {},
        users: [{ id: "u-stu-fake", matricNumber: "STU-IMPOSTOR", role: "STUDENT" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "STU-IMPOSTOR" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-1", student_uid: "STU-1" }],
      });

      const res = await settleRideTransaction(
        {
          cardUid: "CARD-1",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "STU-IMPOSTOR",
          location: "A",
          timestamp: 1784486002,
          protocolVersion: "v1.1.0L",
        },
        db
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "DRIVER_NOT_AUTHORIZED");
      assert.equal(db.getState().studentWallets.get("STU-1"), 500);
    });

    it("should reject terminal with no active driver logged in", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-1": 500 },
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: null }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-1", student_uid: "STU-1" }],
      });

      const res = await settleRideTransaction(
        {
          cardUid: "CARD-1",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784486003,
          protocolVersion: "v1.1.0L",
        },
        db
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "DRIVER_NOT_AUTHORIZED");
    });

    it("should reject when terminal has driver A but payload claims driver B", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-1": 500 },
        users: [
          { id: "u-drv-a", matricNumber: "DRV-A", role: "DRIVER" },
          { id: "u-drv-b", matricNumber: "DRV-B", role: "DRIVER" },
        ],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-A" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-1", student_uid: "STU-1" }],
      });

      const res = await settleRideTransaction(
        {
          cardUid: "CARD-1",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-B",
          location: "A",
          timestamp: 1784486004,
          protocolVersion: "v1.1.0L",
        },
        db
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "DRIVER_NOT_AUTHORIZED");
      assert.equal(db.getState().studentWallets.get("STU-1"), 500);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. LOCATION VALIDATION (Section 6)
  // ──────────────────────────────────────────────────────────────────────────
  describe("6. Location Validation", () => {
    it("should process valid location combinations A, B, and C", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-LOC": 1000 },
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [
          { terminal_id: "TERM-A", location: "A", active_driver_uid: "DRV-1" },
          { terminal_id: "TERM-B", location: "B", active_driver_uid: "DRV-1" },
          { terminal_id: "TERM-C", location: "C", active_driver_uid: "DRV-1" },
        ],
        fareConfigs: [
          { code: "A", location_code: "A", amount: 150, is_active: true },
          { code: "B", location_code: "B", amount: 200, is_active: true },
          { code: "C", location_code: "C", amount: 300, is_active: true },
        ],
        cardMappings: [{ card_uid: "CARD-LOC", student_uid: "STU-LOC" }],
      });

      const resA = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-A", fare: 150, driverUid: "DRV-1", location: "A", timestamp: 1784487001, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resA.success, true);

      const resB = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-B", fare: 200, driverUid: "DRV-1", location: "B", timestamp: 1784487002, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resB.success, true);

      const resC = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-C", fare: 300, driverUid: "DRV-1", location: "C", timestamp: 1784487003, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resC.success, true);
    });

    it("should fail closed on location mismatches between payload and terminal", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-LOC": 1000 },
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [
          { terminal_id: "TERM-A", location: "A", active_driver_uid: "DRV-1" },
          { terminal_id: "TERM-B", location: "B", active_driver_uid: "DRV-1" },
          { terminal_id: "TERM-C", location: "C", active_driver_uid: "DRV-1" },
        ],
        fareConfigs: [
          { code: "A", location_code: "A", amount: 150, is_active: true },
          { code: "B", location_code: "B", amount: 200, is_active: true },
          { code: "C", location_code: "C", amount: 300, is_active: true },
        ],
        cardMappings: [{ card_uid: "CARD-LOC", student_uid: "STU-LOC" }],
      });

      // A + terminal B
      const resAB = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-B", fare: 150, driverUid: "DRV-1", location: "A", timestamp: 1784487101, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resAB.success, false);
      assert.equal(resAB.error, "LOCATION_MISMATCH");

      // B + terminal C
      const resBC = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-C", fare: 200, driverUid: "DRV-1", location: "B", timestamp: 1784487102, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resBC.success, false);
      assert.equal(resBC.error, "LOCATION_MISMATCH");

      // C + terminal A
      const resCA = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-A", fare: 300, driverUid: "DRV-1", location: "C", timestamp: 1784487103, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resCA.success, false);
      assert.equal(resCA.error, "LOCATION_MISMATCH");
    });

    it("should reject invalid location code and missing location in v1.1.0L", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-LOC": 1000 },
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-A", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-LOC", student_uid: "STU-LOC" }],
      });

      // Invalid location code
      const resInvalid = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-A", fare: 150, driverUid: "DRV-1", location: "INVALID_LOC", timestamp: 1784487201, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resInvalid.success, false);
      assert.equal(resInvalid.error, "INVALID_LOCATION");

      // Missing location
      const resMissing = await settleRideTransaction(
        { cardUid: "CARD-LOC", terminalId: "TERM-A", fare: 150, driverUid: "DRV-1", location: undefined, timestamp: 1784487202, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resMissing.success, false);
      assert.equal(resMissing.error, "INVALID_LOCATION");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. FARE & FARECONFIG VALIDATION (Section 7)
  // ──────────────────────────────────────────────────────────────────────────
  describe("7. Fare & FareConfig Validation", () => {
    it("should settle exact configured fare and reject too high, too low, zero, and missing config", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-FARE": 2000 },
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [
          { terminal_id: "TERM-B", location: "B", active_driver_uid: "DRV-1" },
          { terminal_id: "TERM-C", location: "C", active_driver_uid: "DRV-1" }, // C has valid location but no FareConfig in DB
        ],
        fareConfigs: [{ code: "B", location_code: "B", amount: 200, is_active: true }],
        cardMappings: [{ card_uid: "CARD-FARE", student_uid: "STU-FARE" }],
      });

      // Too low (₦150 for Location B)
      const resLow = await settleRideTransaction(
        { cardUid: "CARD-FARE", terminalId: "TERM-B", fare: 150, driverUid: "DRV-1", location: "B", timestamp: 1784488001, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resLow.success, false);
      assert.equal(resLow.error, "FARE_MISMATCH");

      // Too high (₦300 for Location B)
      const resHigh = await settleRideTransaction(
        { cardUid: "CARD-FARE", terminalId: "TERM-B", fare: 300, driverUid: "DRV-1", location: "B", timestamp: 1784488002, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resHigh.success, false);
      assert.equal(resHigh.error, "FARE_MISMATCH");

      // Zero fare
      const resZero = await settleRideTransaction(
        { cardUid: "CARD-FARE", terminalId: "TERM-B", fare: 0, driverUid: "DRV-1", location: "B", timestamp: 1784488003, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resZero.success, false);
      assert.equal(resZero.error, "INVALID_FARE");

      // Missing FareConfig for Location C
      const resMissingConfig = await settleRideTransaction(
        { cardUid: "CARD-FARE", terminalId: "TERM-C", fare: 300, driverUid: "DRV-1", location: "C", timestamp: 1784488004, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resMissingConfig.success, false);
      assert.equal(resMissingConfig.error, "FARE_CONFIG_MISSING");

      // Exactly ₦200 for Location B
      const resExact = await settleRideTransaction(
        { cardUid: "CARD-FARE", terminalId: "TERM-B", fare: 200, driverUid: "DRV-1", location: "B", timestamp: 1784488005, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(resExact.success, true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. FINANCIAL ROLLBACK / ATOMICITY (Section 8)
  // ──────────────────────────────────────────────────────────────────────────
  describe("8. Financial Rollback & Settlement Atomicity", () => {
    it("should completely roll back student debit when driver credit throws", async () => {
      const initialStudentBalance = 500;
      let studentBal = initialStudentBalance;
      let driverBal = 0;
      let systemBal = 0;
      let txRecorded = false;

      const failingDriverDb: any = {
        transaction: { findUnique: async () => null, findFirst: async () => null },
        terminal: { findUnique: async () => ({ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }) },
        fareConfig: { findUnique: async () => ({ code: "A", amount: 150, is_active: true }) },
        cardMapping: { findUnique: async () => ({ card_uid: "CARD-ROLLBACK-1", student_uid: "STU-RB-1" }) },
        user: { findUnique: async () => ({ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }) },

        $transaction: async (fn: any) => {
          let stagedStudentBal = studentBal;
          const txProxy: any = {
            cardMapping: { findUnique: async () => ({ card_uid: "CARD-ROLLBACK-1", student_uid: "STU-RB-1" }) },
            terminal: { findUnique: async () => ({ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }) },
            fareConfig: { findUnique: async () => ({ code: "A", amount: 150, is_active: true }) },
            user: { findUnique: async () => ({ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }) },
            transaction: { findUnique: async () => null, findFirst: async () => null },
            wallet: {
              findUnique: async () => ({ balance: stagedStudentBal }),
              updateMany: async ({ data }: any) => {
                stagedStudentBal -= data.balance.decrement;
                return { count: 1 };
              },
            },
            driverWallet: {
              upsert: async () => {
                throw new Error("DATABASE_DRIVER_WALLET_UNAVAILABLE");
              },
            },
            systemWallet: {
              upsert: async () => ({ balance: 6 }),
            },
          };

          // If fn throws, stagedStudentBal is discarded!
          await fn(txProxy);
          studentBal = stagedStudentBal;
        },
      };

      const res = await settleRideTransaction(
        {
          cardUid: "CARD-ROLLBACK-1",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784489001,
          protocolVersion: "v1.1.0L",
        },
        failingDriverDb
      );

      assert.equal(res.success, false);
      assert.match(res.error || "", /DATABASE_DRIVER_WALLET_UNAVAILABLE/);
      assert.equal(studentBal, initialStudentBalance, "Student balance must remain unchanged after rollback");
      assert.equal(driverBal, 0, "Driver balance must remain 0");
      assert.equal(systemBal, 0, "System balance must remain 0");
      assert.equal(txRecorded, false, "No transaction record must be created");
    });

    it("should completely roll back student debit and driver credit when transaction creation throws", async () => {
      const initialStudentBalance = 500;
      let studentBal = initialStudentBalance;
      let driverBal = 0;
      let systemBal = 0;

      const failingTxCreationDb: any = {
        transaction: { findUnique: async () => null, findFirst: async () => null },
        terminal: { findUnique: async () => ({ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }) },
        fareConfig: { findUnique: async () => ({ code: "A", amount: 150, is_active: true }) },
        cardMapping: { findUnique: async () => ({ card_uid: "CARD-ROLLBACK-2", student_uid: "STU-RB-2" }) },
        user: { findUnique: async () => ({ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }) },

        $transaction: async (fn: any) => {
          let stagedStudentBal = studentBal;
          let stagedDriverBal = driverBal;
          let stagedSystemBal = systemBal;

          const txProxy: any = {
            cardMapping: { findUnique: async () => ({ card_uid: "CARD-ROLLBACK-2", student_uid: "STU-RB-2" }) },
            terminal: { findUnique: async () => ({ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }) },
            fareConfig: { findUnique: async () => ({ code: "A", amount: 150, is_active: true }) },
            user: { findUnique: async () => ({ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }) },
            transaction: {
              findUnique: async () => null,
              findFirst: async () => null,
              create: async () => {
                throw new Error("DISK_FULL_CANNOT_WRITE_AUDIT");
              },
            },
            wallet: {
              findUnique: async () => ({ balance: stagedStudentBal }),
              updateMany: async ({ data }: any) => {
                stagedStudentBal -= data.balance.decrement;
                return { count: 1 };
              },
            },
            driverWallet: {
              upsert: async ({ update }: any) => {
                stagedDriverBal += update.balance.increment;
                return { balance: stagedDriverBal };
              },
            },
            systemWallet: {
              upsert: async ({ update }: any) => {
                stagedSystemBal += update.balance.increment;
                return { balance: stagedSystemBal };
              },
            },
          };

          await fn(txProxy);
          studentBal = stagedStudentBal;
          driverBal = stagedDriverBal;
          systemBal = stagedSystemBal;
        },
      };

      const res = await settleRideTransaction(
        {
          cardUid: "CARD-ROLLBACK-2",
          terminalId: "TERM-1",
          fare: 150,
          driverUid: "DRV-1",
          location: "A",
          timestamp: 1784489002,
          protocolVersion: "v1.1.0L",
        },
        failingTxCreationDb
      );

      assert.equal(res.success, false);
      assert.match(res.error || "", /DISK_FULL_CANNOT_WRITE_AUDIT/);
      assert.equal(studentBal, initialStudentBalance, "Student balance must not change");
      assert.equal(driverBal, 0, "Driver balance must not change");
      assert.equal(systemBal, 0, "System balance must not change");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9. FAILURE / RETRY SCENARIOS (Section 10)
  // ──────────────────────────────────────────────────────────────────────────
  describe("9. Failure & Retry Scenarios", () => {
    it("should succeed on retry after initial transient database error without double debit", async () => {
      let failCount = 1;
      const db = createACIDMockDb({
        studentBalances: { "STU-RETRY-1": 500 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-RETRY-1", student_uid: "STU-RETRY-1" }],
      });

      const originalTx = db.$transaction;
      db.$transaction = async (fn: any) => {
        if (failCount > 0) {
          failCount--;
          throw new Error("ETIMEDOUT: Connection to database failed");
        }
        return originalTx(fn);
      };

      const payload = {
        cardUid: "CARD-RETRY-1",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784490001,
        protocolVersion: "v1.1.0L",
      };

      // Attempt 1 fails due to timeout
      const res1 = await settleRideTransaction(payload, db);
      assert.equal(res1.success, false);
      assert.match(res1.error || "", /ETIMEDOUT/);
      assert.equal(db.getState().studentWallets.get("STU-RETRY-1"), 500);

      // Attempt 2 (Client Retry) succeeds
      const res2 = await settleRideTransaction(payload, db);
      assert.equal(res2.success, true);
      assert.equal(db.getState().studentWallets.get("STU-RETRY-1"), 350);
      assert.equal(db.getState().driverWallets.get("DRV-1")!.balance, 144);
      assert.equal(db.getState().transactions.length, 1);
    });

    it("should recognize duplicate when response was lost and client retries", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-LOST-RESP": 500 },
        driverBalances: { "DRV-1": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
        fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
        cardMappings: [{ card_uid: "CARD-LOST-RESP", student_uid: "STU-LOST-RESP" }],
      });

      const payload = {
        cardUid: "CARD-LOST-RESP",
        terminalId: "TERM-1",
        fare: 150,
        driverUid: "DRV-1",
        location: "A",
        timestamp: 1784490002,
        protocolVersion: "v1.1.0L",
      };

      // Backend settled, but HTTP response was lost by network
      const res1 = await settleRideTransaction(payload, db);
      assert.equal(res1.success, true);

      // Terminal client retries
      const res2 = await settleRideTransaction(payload, db);
      assert.equal(res2.success, true);
      assert.equal(res2.alreadyProcessed, true);

      const state = db.getState();
      assert.equal(state.studentWallets.get("STU-LOST-RESP"), 350);
      assert.equal(state.driverWallets.get("DRV-1")!.balance, 144);
      assert.equal(state.transactions.length, 1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 10. MALFORMED / HOSTILE INPUT (Section 11)
  // ──────────────────────────────────────────────────────────────────────────
  describe("10. Malformed & Hostile Input Resilience", () => {
    const db = createACIDMockDb({
      studentBalances: { "STU-HOSTILE": 1000 },
      driverBalances: { "DRV-1": 0 },
      systemBalance: 0,
      users: [{ id: "u-drv-1", matricNumber: "DRV-1", role: "DRIVER" }],
      terminals: [{ terminal_id: "TERM-1", location: "A", active_driver_uid: "DRV-1" }],
      fareConfigs: [{ code: "A", location_code: "A", amount: 150, is_active: true }],
      cardMappings: [{ card_uid: "CARD-HOSTILE", student_uid: "STU-HOSTILE" }],
    });

    it("should reject missing or empty card UID", async () => {
      const res = await settleRideTransaction(
        { cardUid: "", studentUid: "", terminalId: "TERM-1", fare: 150, driverUid: "DRV-1", location: "A", timestamp: 1784491001 },
        db
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "MALFORMED_TRANSACTION");
      assert.equal(db.getState().studentWallets.get("STU-HOSTILE"), 1000);
    });

    it("should reject missing or invalid amount", async () => {
      const resNaN = await settleRideTransaction(
        { cardUid: "CARD-HOSTILE", terminalId: "TERM-1", fare: NaN, driverUid: "DRV-1", location: "A", timestamp: 1784491002 },
        db
      );
      assert.equal(resNaN.success, false);
      assert.equal(resNaN.error, "INVALID_FARE");

      const resNegative = await settleRideTransaction(
        { cardUid: "CARD-HOSTILE", terminalId: "TERM-1", fare: -150, driverUid: "DRV-1", location: "A", timestamp: 1784491003 },
        db
      );
      assert.equal(resNegative.success, false);
      assert.equal(resNegative.error, "INVALID_FARE");
    });

    it("should reject invalid timestamp in v1.1.0L", async () => {
      const res = await settleRideTransaction(
        { cardUid: "CARD-HOSTILE", terminalId: "TERM-1", fare: 150, driverUid: "DRV-1", location: "A", timestamp: "INVALID_EPOCH" as any, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "INVALID_TIMESTAMP");
    });

    it("should reject extremely large amount without crashing", async () => {
      const res = await settleRideTransaction(
        { cardUid: "CARD-HOSTILE", terminalId: "TERM-1", fare: 999999999, driverUid: "DRV-1", location: "A", timestamp: 1784491004, protocolVersion: "v1.1.0L" },
        db
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "FARE_MISMATCH"); // Location A only allows ₦150
      assert.equal(db.getState().studentWallets.get("STU-HOSTILE"), 1000);
    });

    it("should reject malformed raw batch lines in parser cleanly without crash", () => {
      const malformedBatch = `
        INVALID_FORMAT_LINE
        9AF7F0:238DB4E8,NOT_AN_AMOUNT,1784485554,83,A
        9AF7F0:238DB4E8,-150,NOT_A_TIMESTAMP,83,A
        ,,,,,
        9AF7F0:238DB4E8,-150,1784485554,83,A
      `;

      const result = parseTransactionBatch(malformedBatch, "9AF7F0");
      assert.equal(result.valid.length, 1);
      assert.equal(result.valid[0].student_uid, "238DB4E8");
      assert.equal(result.valid[0].amount, 150);
      assert.equal(result.invalid.length, 4);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 11. LEGACY COMPATIBILITY (Section 13)
  // ──────────────────────────────────────────────────────────────────────────
  describe("11. Legacy Compatibility", () => {
    it("should safely process legacy Format A and Format B payloads without bypassing safety", async () => {
      const db = createACIDMockDb({
        studentBalances: { "STU-LEGACY-01": 500 },
        driverBalances: { "DRV-10": 0 },
        systemBalance: 0,
        users: [{ id: "u-drv-10", matricNumber: "DRV-10", role: "DRIVER" }],
        terminals: [{ terminal_id: "TERM-LEGACY", active_driver_uid: "DRV-10" }],
      });

      // Legacy Format A CSV line: transaction_id, student_uid, amount, timestamp, driver_uid
      const lineA = "TX-LEGACY-001,STU-LEGACY-01,100,1784492001,DRV-10";
      const parsedA = parseSingleTransaction(lineA, "TERM-LEGACY");
      assert.equal(parsedA.error, undefined);
      assert.equal(parsedA.data?.transaction_id, "TX-LEGACY-001");
      assert.equal(parsedA.data?.amount, 100);

      const resA = await settleRideTransaction(
        {
          transactionId: parsedA.data!.transaction_id,
          studentUid: parsedA.data!.student_uid,
          terminalId: parsedA.data!.terminal_id,
          fare: parsedA.data!.amount,
          driverUid: parsedA.data!.driver_uid || undefined,
        },
        db
      );

      assert.equal(resA.success, true);
      assert.equal(resA.studentBalance, 400);
      assert.equal(resA.driverBalance, 96);
      assert.equal(resA.ctransitBalance, 4);

      // Verify legacy duplicate still safely detected
      const resADup = await settleRideTransaction(
        {
          transactionId: parsedA.data!.transaction_id,
          studentUid: parsedA.data!.student_uid,
          terminalId: parsedA.data!.terminal_id,
          fare: parsedA.data!.amount,
          driverUid: parsedA.data!.driver_uid || undefined,
        },
        db
      );
      assert.equal(resADup.success, true);
      assert.equal(resADup.alreadyProcessed, true);
      assert.equal(db.getState().studentWallets.get("STU-LEGACY-01"), 400);
    });
  });
});
