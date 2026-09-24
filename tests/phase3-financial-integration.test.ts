import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  settleRideTransaction,
  generateTransactionFingerprint,
  resolveStudentMatricFromCard,
  calculateFareSplit,
} from "../src/services/ledger.service.js";

/**
 * Phase 3 — Financial Integration & Validation Test Suite
 * 25 Comprehensive Test Cases across all specification requirements:
 * 1. Card UID -> Student Resolution (Tests 1-5)
 * 2. Driver Authorization & Terminal Assignment (Tests 6-10)
 * 3. Location Validation (Tests 11-13)
 * 4. Fare Validation & Fail-Closed Behavior (Tests 14-17)
 * 5. Atomic Settlement & 96/4 Split Calculations (Tests 18-21)
 * 6. Idempotency & Concurrency Hardening (Tests 22-25)
 */

describe("Phase 3 — 1. Card UID -> Student Resolution", () => {
  it("Test 1: Physical NFC card UID successfully resolves to student matricNumber via CardMapping", async () => {
    const mockDb: any = {
      cardMapping: {
        findUnique: async ({ where }: any) => {
          if (where.card_uid === "04A1B2C3D4") {
            return { card_uid: "04A1B2C3D4", student_uid: "2023/1/10001CS" };
          }
          return null;
        },
      },
    };

    const matric = await resolveStudentMatricFromCard("04A1B2C3D4", mockDb);
    assert.equal(matric, "2023/1/10001CS");
  });

  it("Test 2: Unmapped card UID (not in CardMapping) is rejected with CARD_NOT_MAPPED", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-101",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-drv-101", role: "DRIVER", matricNumber: "DRV-101" }),
          },
          cardMapping: {
            findUnique: async () => null, // Unmapped!
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-002",
        studentUid: "UNKNOWN_CARD_UID",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-101",
        location: "A",
        protocolVersion: "v1.1.0L",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "CARD_NOT_MAPPED");
    assert.equal(result.error, "CARD_NOT_MAPPED");
  });

  it("Test 3: Unmapped card does NOT debit student wallet", async () => {
    let walletDebitCalled = false;
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-101",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-drv-101", role: "DRIVER", matricNumber: "DRV-101" }),
          },
          cardMapping: {
            findUnique: async () => null,
          },
          wallet: {
            updateMany: async () => {
              walletDebitCalled = true;
              return { count: 1 };
            },
            update: async () => {
              walletDebitCalled = true;
              return { balance: 0 };
            },
          },
        };
        return fn(tx);
      },
    };

    await settleRideTransaction(
      {
        transactionId: "TX-P3-003",
        studentUid: "UNMAPPED_CARD_999",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-101",
        location: "A",
        protocolVersion: "v1.1.0L",
      },
      mockDb
    );

    assert.equal(walletDebitCalled, false, "Student wallet must never be debited when card is unmapped");
  });

  it("Test 4: Unmapped card does NOT credit driver wallet or C-Transit wallet", async () => {
    let driverCreditCalled = false;
    let systemCreditCalled = false;
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-101",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-drv-101", role: "DRIVER", matricNumber: "DRV-101" }),
          },
          cardMapping: { findUnique: async () => null },
          driverWallet: {
            upsert: async () => {
              driverCreditCalled = true;
              return { balance: 144 };
            },
          },
          systemWallet: {
            upsert: async () => {
              systemCreditCalled = true;
              return { balance: 6 };
            },
          },
        };
        return fn(tx);
      },
    };

    await settleRideTransaction(
      {
        transactionId: "TX-P3-004",
        studentUid: "UNMAPPED_CARD_888",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-101",
        location: "A",
        protocolVersion: "v1.1.0L",
      },
      mockDb
    );

    assert.equal(driverCreditCalled, false, "Driver wallet must not be credited for unmapped card");
    assert.equal(systemCreditCalled, false, "C-Transit wallet must not be credited for unmapped card");
  });

  it("Test 5: Transaction record retains raw card_uid while linking student_uid to resolved matricNumber", async () => {
    let createdTx: any = null;
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: {
            findUnique: async () => null,
            findFirst: async () => null,
            create: async ({ data }: any) => {
              createdTx = data;
              return data;
            },
          },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-101",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-drv-101", role: "DRIVER", matricNumber: "DRV-101" }),
          },
          cardMapping: {
            findUnique: async () => ({ card_uid: "CARD-ABC-123", student_uid: "2021/1/99999EC" }),
          },
          wallet: {
            findUnique: async () => ({ balance: 1000 }),
            updateMany: async () => ({ count: 1 }),
          },
          driverWallet: { upsert: async () => ({ balance: 144 }) },
          systemWallet: { upsert: async () => ({ balance: 6 }) },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-005",
        studentUid: "CARD-ABC-123",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-101",
        location: "A",
        protocolVersion: "v1.1.0L",
      },
      mockDb
    );

    assert.equal(result.success, true);
    assert.ok(createdTx);
    assert.equal(createdTx.student_uid, "2021/1/99999EC", "student_uid must be resolved matricNumber");
    assert.equal(createdTx.card_uid, "CARD-ABC-123", "card_uid must preserve raw NFC card UID");
  });
});

describe("Phase 3 — 2. Driver Authorization & Terminal Assignment", () => {
  it("Test 6: Payload driver_uid matching terminal active_driver_uid is authorized", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: {
            findUnique: async () => null,
            findFirst: async () => null,
            create: async ({ data }: any) => data,
          },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-AUTH-01",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u1", role: "DRIVER", matricNumber: "DRV-AUTH-01" }),
          },
          cardMapping: {
            findUnique: async () => ({ card_uid: "CARD-1", student_uid: "MATRIC-1" }),
          },
          wallet: {
            findUnique: async () => ({ balance: 500 }),
            updateMany: async () => ({ count: 1 }),
          },
          driverWallet: { upsert: async () => ({ balance: 144 }) },
          systemWallet: { upsert: async () => ({ balance: 6 }) },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-006",
        studentUid: "CARD-1",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-AUTH-01",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, true);
  });

  it("Test 7: Payload driver_uid mismatching terminal active_driver_uid is rejected with DRIVER_NOT_AUTHORIZED", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-AUTHORITATIVE",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u2", role: "DRIVER", matricNumber: "DRV-IMPOSTOR" }),
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-007",
        studentUid: "CARD-1",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-IMPOSTOR",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "DRIVER_NOT_AUTHORIZED");
  });

  it("Test 8: Terminal with no active driver logged in (active_driver_uid == null) is rejected with DRIVER_NOT_AUTHORIZED", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: null, // No active driver
            }),
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-008",
        studentUid: "CARD-1",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-101",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "DRIVER_NOT_AUTHORIZED");
  });

  it("Test 9: Driver UID not found in User table is rejected with DRIVER_NOT_FOUND", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-NONEXISTENT",
            }),
          },
          user: {
            findUnique: async () => null, // User not found
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-009",
        studentUid: "CARD-1",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-NONEXISTENT",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "DRIVER_NOT_FOUND");
  });

  it("Test 10: Driver user without DRIVER role is rejected with DRIVER_NOT_AUTHORIZED", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "STU-PRETENDING-DRIVER",
            }),
          },
          user: {
            findUnique: async () => ({
              id: "u-stu-1",
              role: "STUDENT", // Not a DRIVER!
              matricNumber: "STU-PRETENDING-DRIVER",
            }),
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-010",
        studentUid: "CARD-1",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "STU-PRETENDING-DRIVER",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "DRIVER_NOT_AUTHORIZED");
  });
});

describe("Phase 3 — 3. Location Validation", () => {
  it("Test 11: Payload location matching terminal configured location is accepted", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: {
            findUnique: async () => null,
            findFirst: async () => null,
            create: async ({ data }: any) => data,
          },
          fareConfig: {
            findUnique: async () => ({ code: "B", location_code: "B", amount: 200 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-B",
              location: "B",
              active_driver_uid: "DRV-B",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-drv-b", role: "DRIVER", matricNumber: "DRV-B" }),
          },
          cardMapping: {
            findUnique: async () => ({ card_uid: "C-B", student_uid: "M-B" }),
          },
          wallet: {
            findUnique: async () => ({ balance: 400 }),
            updateMany: async () => ({ count: 1 }),
          },
          driverWallet: { upsert: async () => ({ balance: 192 }) },
          systemWallet: { upsert: async () => ({ balance: 8 }) },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-011",
        studentUid: "C-B",
        terminalId: "TERM-B",
        fare: 200,
        driverUid: "DRV-B",
        location: "B",
      },
      mockDb
    );

    assert.equal(result.success, true);
  });

  it("Test 12: Payload location mismatching terminal configured location is rejected with LOCATION_MISMATCH", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "B", location_code: "B", amount: 200 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-A-PHYSICAL",
              location: "A", // Terminal is at location A
              active_driver_uid: "DRV-A",
            }),
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-012",
        studentUid: "C-1",
        terminalId: "TERM-A-PHYSICAL",
        fare: 200,
        driverUid: "DRV-A",
        location: "B", // Payload claims location B
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "LOCATION_MISMATCH");
  });

  it("Test 13: Invalid location code (e.g., 'X') is rejected with INVALID_LOCATION", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-013",
        studentUid: "C-1",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-1",
        location: "X", // Unknown location
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "INVALID_LOCATION");
  });
});

describe("Phase 3 — 4. Fare Validation & Fail-Closed Behavior", () => {
  it("Test 14: Location B with expected fare ₦200 matches FareConfig and is accepted", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: {
            findUnique: async () => null,
            findFirst: async () => null,
            create: async ({ data }: any) => data,
          },
          fareConfig: {
            findUnique: async ({ where }: any) => {
              if (where.code === "B") return { code: "B", location_code: "B", amount: 200 };
              return null;
            },
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-B",
              location: "B",
              active_driver_uid: "DRV-B",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-b", role: "DRIVER", matricNumber: "DRV-B" }),
          },
          cardMapping: {
            findUnique: async () => ({ card_uid: "CARD-B", student_uid: "STU-B" }),
          },
          wallet: {
            findUnique: async () => ({ balance: 500 }),
            updateMany: async () => ({ count: 1 }),
          },
          driverWallet: { upsert: async () => ({ balance: 192 }) },
          systemWallet: { upsert: async () => ({ balance: 8 }) },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-014",
        studentUid: "CARD-B",
        terminalId: "TERM-B",
        fare: 200,
        driverUid: "DRV-B",
        location: "B",
      },
      mockDb
    );

    assert.equal(result.success, true);
  });

  it("Test 15: Location B with wrong fare ₦150 is rejected with FARE_MISMATCH", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "B", location_code: "B", amount: 200 }),
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-015",
        studentUid: "CARD-B",
        terminalId: "TERM-B",
        fare: 150, // Mismatched: expected 200
        driverUid: "DRV-B",
        location: "B",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "FARE_MISMATCH");
  });

  it("Test 16: Location B with wrong fare ₦300 is rejected with FARE_MISMATCH", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "B", location_code: "B", amount: 200 }),
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-016",
        studentUid: "CARD-B",
        terminalId: "TERM-B",
        fare: 300, // Mismatched: expected 200
        driverUid: "DRV-B",
        location: "B",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "FARE_MISMATCH");
  });

  it("Test 17: Missing FareConfig for location fails closed with FARE_CONFIG_MISSING", async () => {
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => null, // Missing in DB!
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-017",
        studentUid: "CARD-C",
        terminalId: "TERM-C",
        fare: 300,
        driverUid: "DRV-C",
        location: "C",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "FARE_CONFIG_MISSING");
  });
});

describe("Phase 3 — 5. Atomic Settlement & 96/4 Split Calculations", () => {
  it("Test 18: Standard fare Location A (₦150) splits exactly: ₦144 driver (96%) and ₦6 C-Transit (4%)", () => {
    const splitA = calculateFareSplit(150);
    assert.equal(splitA.fare, 150);
    assert.equal(splitA.driverShare, 144);
    assert.equal(splitA.ctransitShare, 6);
    assert.equal(splitA.driverShare + splitA.ctransitShare, 150);
  });

  it("Test 19: Location B fare (₦200) splits exactly: ₦192 driver (96%) and ₦8 C-Transit (4%)", () => {
    const splitB = calculateFareSplit(200);
    assert.equal(splitB.fare, 200);
    assert.equal(splitB.driverShare, 192);
    assert.equal(splitB.ctransitShare, 8);
    assert.equal(splitB.driverShare + splitB.ctransitShare, 200);
  });

  it("Test 20: Location C fare (₦300) splits exactly: ₦288 driver (96%) and ₦12 C-Transit (4%)", () => {
    const splitC = calculateFareSplit(300);
    assert.equal(splitC.fare, 300);
    assert.equal(splitC.driverShare, 288);
    assert.equal(splitC.ctransitShare, 12);
    assert.equal(splitC.driverShare + splitC.ctransitShare, 300);
  });

  it("Test 21: Insufficient student balance rejects transaction with INSUFFICIENT_FUNDS and performs zero credits", async () => {
    let driverCredited = false;
    let ctransitCredited = false;
    const mockDb: any = {
      transaction: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: { findUnique: async () => null, findFirst: async () => null },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-101",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-drv-101", role: "DRIVER", matricNumber: "DRV-101" }),
          },
          cardMapping: {
            findUnique: async () => ({ card_uid: "CARD-BROKE", student_uid: "MATRIC-BROKE" }),
          },
          wallet: {
            findUnique: async () => ({ balance: 50 }), // Only 50 Naira available, fare is 150!
          },
          driverWallet: {
            upsert: async () => {
              driverCredited = true;
              return { balance: 144 };
            },
          },
          systemWallet: {
            upsert: async () => {
              ctransitCredited = true;
              return { balance: 6 };
            },
          },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-P3-021",
        studentUid: "CARD-BROKE",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-101",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, false);
    assert.equal(result.rejectionReason, "INSUFFICIENT_FUNDS");
    assert.equal(result.studentBalance, 50);
    assert.equal(driverCredited, false);
    assert.equal(ctransitCredited, false);
  });
});

describe("Phase 3 — 6. Idempotency & Concurrency Hardening", () => {
  it("Test 22: Deterministic fingerprint generates identical SHA-256 hash for identical raw parameters", () => {
    const params1 = {
      protocolVersion: "v1.1.0L",
      terminalId: "9AF7F0",
      cardUid: "238DB4E8",
      rawAmount: "-150",
      timestamp: 1784485554,
      driverUid: "83",
      location: "A",
    };

    const params2 = {
      protocolVersion: "v1.1.0L",
      terminalId: "9AF7F0",
      cardUid: "238DB4E8",
      rawAmount: "-150",
      timestamp: 1784485554,
      driverUid: "83",
      location: "A",
    };

    const hash1 = generateTransactionFingerprint(params1);
    const hash2 = generateTransactionFingerprint(params2);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64, "SHA-256 hash must be 64 hexadecimal characters");

    // Verify expected raw digest match
    const manualCanonical = "v1.1.0L:9AF7F0:238DB4E8:-150:1784485554:83:A";
    const expected = crypto.createHash("sha256").update(manualCanonical).digest("hex");
    assert.equal(hash1, expected);
  });

  it("Test 23: First delivery settles successfully, duplicate delivery returns alreadyProcessed without second financial debit", async () => {
    let studentDebitCount = 0;
    let driverCreditCount = 0;

    const committedTransactions = new Map<string, any>();

    const mockDb: any = {
      transaction: {
        findUnique: async ({ where }: any) => {
          if (where.transaction_id && committedTransactions.has(where.transaction_id)) {
            return committedTransactions.get(where.transaction_id);
          }
          if (where.idempotency_key) {
            for (const tx of committedTransactions.values()) {
              if (tx.idempotency_key === where.idempotency_key) return tx;
            }
          }
          return null;
        },
        findFirst: async ({ where }: any) => {
          if (where.OR) {
            for (const cond of where.OR) {
              if (cond.transaction_id && committedTransactions.has(cond.transaction_id)) {
                return committedTransactions.get(cond.transaction_id);
              }
              if (cond.idempotency_key) {
                for (const tx of committedTransactions.values()) {
                  if (tx.idempotency_key === cond.idempotency_key) return tx;
                }
              }
            }
          }
          return null;
        },
      },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: {
            findUnique: mockDb.transaction.findUnique,
            findFirst: mockDb.transaction.findFirst,
            create: async ({ data }: any) => {
              committedTransactions.set(data.transaction_id, data);
              return data;
            },
          },
          fareConfig: {
            findUnique: async () => ({ code: "A", location_code: "A", amount: 150 }),
          },
          terminal: {
            findUnique: async () => ({
              terminal_id: "TERM-01",
              location: "A",
              active_driver_uid: "DRV-101",
            }),
          },
          user: {
            findUnique: async () => ({ id: "u-drv-101", role: "DRIVER", matricNumber: "DRV-101" }),
          },
          cardMapping: {
            findUnique: async () => ({ card_uid: "CARD-IDEMP-1", student_uid: "MATRIC-IDEMP-1" }),
          },
          wallet: {
            findUnique: async () => ({ balance: 1000 }),
            updateMany: async () => {
              studentDebitCount++;
              return { count: 1 };
            },
          },
          driverWallet: {
            upsert: async () => {
              driverCreditCount++;
              return { balance: 144 };
            },
          },
          systemWallet: { upsert: async () => ({ balance: 6 }) },
        };
        return fn(tx);
      },
    };

    const ridePayload = {
      terminalId: "TERM-01",
      studentUid: "CARD-IDEMP-1",
      fare: 150,
      driverUid: "DRV-101",
      location: "A",
      timestamp: 1784480000,
      protocolVersion: "v1.1.0L",
    };

    // First delivery
    const result1 = await settleRideTransaction(ridePayload, mockDb);
    assert.equal(result1.success, true);
    assert.equal(result1.alreadyProcessed, undefined);
    assert.equal(studentDebitCount, 1);
    assert.equal(driverCreditCount, 1);

    // Duplicate delivery
    const result2 = await settleRideTransaction(ridePayload, mockDb);
    assert.equal(result2.success, true);
    assert.equal(result2.alreadyProcessed, true);
    assert.equal(studentDebitCount, 1, "Student must not be debited a second time");
    assert.equal(driverCreditCount, 1, "Driver must not be credited a second time");
  });

  it("Test 24: Legitimate ride with different terminal timestamp produces different fingerprint and is independently processable", async () => {
    const hash1 = generateTransactionFingerprint({
      protocolVersion: "v1.1.0L",
      terminalId: "9AF7F0",
      cardUid: "238DB4E8",
      rawAmount: 150,
      timestamp: 1784485554,
      driverUid: "83",
      location: "A",
    });

    const hash2 = generateTransactionFingerprint({
      protocolVersion: "v1.1.0L",
      terminalId: "9AF7F0",
      cardUid: "238DB4E8",
      rawAmount: 150,
      timestamp: 1784489999, // Later ride
      driverUid: "83",
      location: "A",
    });

    assert.notEqual(hash1, hash2, "Different terminal timestamp must yield a different fingerprint");
  });

  it("Test 25: Concurrent duplicate settlement race (P2002 unique constraint) safely recovers without double-debiting", async () => {
    let raceAttempts = 0;
    const existingRecordedTx = {
      transaction_id: "TX-RACE-WINNER",
      idempotency_key: "IDEMP-RACE-001",
      fare: 150,
      student_uid: "MATRIC-RACE",
    };

    const mockDb: any = {
      transaction: {
        findUnique: async () => null, // Pre-check sees nothing (simulating race)
        findFirst: async () => null,
      },
      $transaction: async () => {
        raceAttempts++;
        // Throws Prisma unique constraint P2002 on idempotency_key or transaction_id
        const p2002Err: any = new Error("Unique constraint failed on the fields: (`idempotency_key`)");
        p2002Err.code = "P2002";
        // After collision, dbClient sees the inserted record
        mockDb.transaction.findUnique = async () => existingRecordedTx;
        mockDb.transaction.findFirst = async () => existingRecordedTx;
        throw p2002Err;
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-RACE-WINNER",
        idempotencyKey: "IDEMP-RACE-001",
        studentUid: "CARD-RACE",
        terminalId: "TERM-01",
        fare: 150,
        driverUid: "DRV-101",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, true);
    assert.equal(result.alreadyProcessed, true);
    assert.deepEqual(result.transaction, existingRecordedTx);
    assert.equal(raceAttempts, 1);
  });
});
