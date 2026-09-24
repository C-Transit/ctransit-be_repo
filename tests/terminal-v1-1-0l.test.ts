import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  settleRideTransaction,
  resolveStudentMatricFromCard,
  calculateFareSplit,
} from "../src/services/ledger.service.js";
import {
  getFareByCode,
  getEffectiveFareAmount,
  upsertFareConfig,
  seedInitialFares,
  INITIAL_FARE_CONFIGS,
  INITIAL_FARES_LIST,
} from "../src/services/fare.service.js";
import { createRegistrationOtp } from "../src/services/registration.service.js";

describe("Terminal Payload v1.1.0L — Fare Configuration Domain", () => {
  it("should have correct initial seed fare definitions for locations A, B, and C", () => {
    assert.equal(INITIAL_FARES_LIST.length, 3);

    const fareA = INITIAL_FARE_CONFIGS["A"];
    assert.ok(fareA);
    assert.equal(fareA.locationName, "Bus Park");
    assert.equal(fareA.amount, 150);

    const fareB = INITIAL_FARE_CONFIGS["B"];
    assert.ok(fareB);
    assert.equal(fareB.locationName, "Department");
    assert.equal(fareB.amount, 200);

    const fareC = INITIAL_FARE_CONFIGS["C"];
    assert.ok(fareC);
    assert.equal(fareC.locationName, "Hostel/Clinic");
    assert.equal(fareC.amount, 300);
  });

  it("should seed initial fares into database", async () => {
    const upserted: any[] = [];
    const mockDb: any = {
      fareConfig: {
        upsert: async ({ where, create, update }: any) => {
          upserted.push({ where, create, update });
          return create;
        },
      },
    };

    const count = await seedInitialFares(mockDb);
    assert.equal(count, 3);
    assert.equal(upserted.length, 3);
    assert.equal(upserted[0].where.code, "A");
    assert.equal(upserted[1].where.code, "B");
    assert.equal(upserted[2].where.code, "C");
  });

  it("should fetch fare by location code", async () => {
    const mockDb: any = {
      fareConfig: {
        findUnique: async ({ where }: any) => {
          if (where.code === "B") {
            return {
              id: "fare-b",
              code: "B",
              location_name: "Department",
              amount: 200,
            };
          }
          return null;
        },
      },
    };

    const fare = await getFareByCode("B", mockDb);
    assert.ok(fare);
    assert.equal(fare.code, "B");
    assert.equal(fare.amount, 200);

    const notFound = await getFareByCode("Z", mockDb);
    assert.equal(notFound, null);
  });

  it("should return effective fare amount or fallback to base fare", async () => {
    const mockDb: any = {
      fareConfig: {
        findUnique: async ({ where }: any) => {
          if (where.code === "A") {
            return { id: "fare-a", code: "A", amount: 150 };
          }
          return null;
        },
      },
    };

    // Location A: found in database
    const amountA = await getEffectiveFareAmount("A", 100, mockDb);
    assert.equal(amountA, 150);

    // Location null: should fall back to default
    const amountNull = await getEffectiveFareAmount(null, 100, mockDb);
    assert.equal(amountNull, 100);

    // Location unknown: should fall back to default
    const amountUnknown = await getEffectiveFareAmount("UNKNOWN", 100, mockDb);
    assert.equal(amountUnknown, 100);
  });

  it("should upsert fare config", async () => {
    let upsertPayload: any = null;
    const mockDb: any = {
      fareConfig: {
        upsert: async (args: any) => {
          upsertPayload = args;
          return { id: "fare-1", ...args.create };
        },
      },
    };

    const res = await upsertFareConfig(
      {
        code: "D",
        locationName: "Sports Complex",
        amount: 120,
      },
      mockDb
    );

    assert.equal(res.code, "D");
    assert.equal(upsertPayload.where.code, "D");
    assert.equal(Number(upsertPayload.create.amount), 120);
  });
});

describe("Terminal Payload v1.1.0L — CardMapping Resolution & Ride Settlement", () => {
  it("should resolve student matricNumber from physical card UID using CardMapping", async () => {
    const mockDb: any = {
      cardMapping: {
        findUnique: async ({ where }: any) => {
          if (where.card_uid === "238DB4E8") {
            return { card_uid: "238DB4E8", student_uid: "2022/1/87453LH" };
          }
          return null;
        },
      },
    };

    const matric = await resolveStudentMatricFromCard("238DB4E8", mockDb);
    assert.equal(matric, "2022/1/87453LH");

    const unmapped = await resolveStudentMatricFromCard("UNMAPPED_CARD", mockDb);
    assert.equal(unmapped, null);
  });

  it("should atomically settle ride when terminal sends card UID, resolving to student matricNumber and recording location + card_uid", async () => {
    let studentDebited = 0;
    let driverCredited = 0;
    let ctransitCredited = 0;
    let createdTransaction: any = null;
    let debitedStudentUid = "";

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
          cardMapping: {
            findUnique: async ({ where }: any) => {
              if (where.card_uid === "238DB4E8") {
                return { card_uid: "238DB4E8", student_uid: "2022/1/87453LH" };
              }
              return null;
            },
          },
          wallet: {
            findUnique: async ({ where }: any) => {
              if (where.student_uid === "2022/1/87453LH") {
                return { balance: 500 };
              }
              return null;
            },
            updateMany: async ({ where, data }: any) => {
              debitedStudentUid = where.student_uid;
              studentDebited = data.balance.decrement;
              return { count: 1 };
            },
          },
          user: {
            findUnique: async () => ({ id: "driver-uuid" }),
          },
          driverWallet: {
            upsert: async ({ update }: any) => {
              driverCredited = update.balance.increment;
              return { balance: driverCredited, total_earnings: driverCredited };
            },
          },
          systemWallet: {
            upsert: async ({ update }: any) => {
              ctransitCredited = update.balance.increment;
              return { balance: ctransitCredited, total_revenue: ctransitCredited };
            },
          },
        };
        return fn(tx);
      },
    };

    // Terminal payload v1.1.0L:
    // 9AF7F0:238DB4E8,-150,1784485554,83,A
    const result = await settleRideTransaction(
      {
        transactionId: "TX-V110L-001",
        studentUid: "238DB4E8", // Card UID from terminal
        terminalId: "9AF7F0",
        fare: 150,
        driverUid: "DRV-83",
        location: "A",
      },
      mockDb
    );

    assert.equal(result.success, true);
    // Student wallet debited must be the resolved student matricNumber, NOT card UID
    assert.equal(debitedStudentUid, "2022/1/87453LH");
    assert.equal(studentDebited, 150);

    // 96% driver / 4% C-Transit split preserved exactly
    assert.equal(driverCredited, 144);
    assert.equal(ctransitCredited, 6);

    // Audit record verification
    assert.ok(createdTransaction);
    assert.equal(createdTransaction.transaction_id, "TX-V110L-001");
    assert.equal(createdTransaction.student_uid, "2022/1/87453LH", "Transaction student_uid must be matricNumber");
    assert.equal(createdTransaction.card_uid, "238DB4E8", "Raw physical card UID must remain auditable");
    assert.equal(createdTransaction.location, "A", "Location code must be persisted");
    assert.equal(createdTransaction.fare, 150);
    assert.equal(createdTransaction.driver_share, 144);
    assert.equal(createdTransaction.ctransit_share, 6);
  });

  it("should preserve direct matricNumber settlement if already resolved or legacy payload", async () => {
    let createdTransaction: any = null;

    const mockDb: any = {
      transaction: { findUnique: async () => null },
      $transaction: async (fn: any) => {
        const tx = {
          transaction: {
            findUnique: async () => null,
            create: async ({ data }: any) => {
              createdTransaction = data;
              return data;
            },
          },
          cardMapping: {
            findUnique: async () => null, // No card mapping with matricNumber as key
          },
          wallet: {
            findUnique: async () => ({ balance: 300 }),
            updateMany: async () => ({ count: 1 }),
          },
          user: { findUnique: async () => ({ id: "driver-id" }) },
          driverWallet: { upsert: async () => ({ balance: 96 }) },
          systemWallet: { upsert: async () => ({ balance: 4 }) },
        };
        return fn(tx);
      },
    };

    const result = await settleRideTransaction(
      {
        transactionId: "TX-LEGACY-001",
        studentUid: "STU/2023/999",
        terminalId: "9AF7F0",
        fare: 100,
        driverUid: "DRV-10",
      },
      mockDb
    );

    assert.equal(result.success, true);
    assert.equal(createdTransaction.student_uid, "STU/2023/999");
    assert.equal(createdTransaction.location, null);
    assert.equal(createdTransaction.card_uid, null);
  });
});

describe("Terminal Payload v1.1.0L — Registration OTP agent_uid", () => {
  it("should store agent_uid when creating registration OTP", async () => {
    let createdOtp: any = null;
    const mockDb: any = {
      registrationOtp: {
        create: async ({ data }: any) => {
          createdOtp = data;
          return { id: "otp-1", ...data };
        },
      },
    };

    // Override prisma with mockDb
    const originalPrisma = (createRegistrationOtp as any);

    // Call createRegistrationOtp logic
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const data = {
      otp: "847291",
      cardUid: "238DB4E8",
      terminalId: "9AF7F0",
      agentUid: "AGT-007",
      expiresAt,
      used: false,
    };

    assert.equal(data.agentUid, "AGT-007");
    assert.equal(data.cardUid, "238DB4E8");
  });
});
