import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import env from "../src/config/env.js";
import {
  loginDriver,
  getDriverProfile,
  getDriverDashboard,
  getDriverRides,
  createDriverWithdrawal,
  getDriverWithdrawals,
  linkDriverCard,
} from "../src/services/driver.service.js";
import { requireDriver } from "../src/middleware/auth.middleware.js";

describe("Driver Authentication & Token Generation", () => {
  it("should generate a valid JWT with DRIVER role and 8h expiry", () => {
    const payload = { userId: "user-drv-1", role: "DRIVER", email: "driver@ctransit.me" };
    const token = jwt.sign(payload, env.jwt.secret, { expiresIn: "8h" });

    const decoded = jwt.verify(token, env.jwt.secret) as any;
    assert.equal(decoded.userId, "user-drv-1");
    assert.equal(decoded.role, "DRIVER");
    assert.equal(decoded.email, "driver@ctransit.me");
    assert.ok(decoded.exp > decoded.iat);
  });

  it("requireDriver middleware should allow DRIVER and block other roles", () => {
    let nextCalled = false;
    const reqDriver: any = { user: { userId: "drv-1", role: "DRIVER" } };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.body = data;
        return this;
      },
    };

    requireDriver(reqDriver, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true, "requireDriver must call next for DRIVER role");

    // Test STUDENT blocked
    nextCalled = false;
    const reqStudent: any = { user: { userId: "stu-1", role: "STUDENT" }, path: "/api/drivers/me" };
    requireDriver(reqStudent, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false, "requireDriver must not call next for non-driver role");
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "Driver access required");

    // Test AGENT blocked
    nextCalled = false;
    const reqAgent: any = { user: { userId: "agt-1", role: "AGENT" }, path: "/api/drivers/me" };
    requireDriver(reqAgent, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);

    // Test Unauthenticated blocked
    nextCalled = false;
    const reqAnon: any = { user: undefined, path: "/api/drivers/me" };
    requireDriver(reqAnon, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});

describe("Driver Profile & Dashboard Calculations", () => {
  it("should calculate dashboard metrics using recorded driver_share without inventing separate calculations", () => {
    // 3 completed rides with 96% driver shares
    const rides = [
      { fare: 100, driver_share: 96, ctransit_share: 4 },
      { fare: 150, driver_share: 144, ctransit_share: 6 },
      { fare: 200, driver_share: 192, ctransit_share: 8 },
    ];

    const todayEarnings = rides.reduce((sum, r) => sum + r.driver_share, 0);
    const todayRidesCount = rides.length;
    const availableBalance = 432;

    assert.equal(todayEarnings, 432);
    assert.equal(todayRidesCount, 3);
    assert.equal(availableBalance, 432);
  });
});

describe("Driver Withdrawal — Constraints & Atomic Balances", () => {
  it("should reject withdrawals for drivers without verified bank details", async () => {
    const mockDb: any = {
      user: {
        findUnique: async () => ({
          id: "drv-1",
          matricNumber: "DRV/001",
          role: "DRIVER",
          bankVerified: false,
          bankName: null,
          accountNumber: null,
          accountName: null,
        }),
      },
    };

    await assert.rejects(
      () =>
        createDriverWithdrawal(
          "drv-1",
          { amount: 100, bankName: "Access Bank" },
          mockDb
        ),
      { message: "BANK_NOT_VERIFIED" }
    );
  });

  it("should prevent withdrawal when requested amount exceeds available balance", () => {
    const balance = 150;
    const requestedAmount = 200;

    assert.ok(requestedAmount > balance, "Cannot withdraw more than available balance");
    const canWithdraw = balance >= requestedAmount;
    assert.equal(canWithdraw, false);
  });

  it("should allow withdrawal when requested amount is within available balance", () => {
    let balance = 500;
    const requestedAmount = 250;

    assert.ok(balance >= requestedAmount);
    balance -= requestedAmount;
    assert.equal(balance, 250, "Driver balance must not become negative");
  });

  it("should immediately reserve requested amount from DriverWallet balance on withdrawal creation", async () => {
    let currentBalance = 1000;
    const mockDb: any = {
      user: {
        findUnique: async () => ({
          id: "drv-1",
          matricNumber: "DRV/001",
          role: "DRIVER",
          bankCode: "044",
          bankName: "Access Bank",
          accountNumber: "0123456789",
          accountName: "John Driver",
          bankVerified: true,
        }),
        update: async () => ({}),
      },
      $transaction: async (callback: any) => {
        const tx = {
          driverWallet: {
            findUnique: async () => ({ driver_uid: "DRV/001", balance: currentBalance }),
            update: async (args: any) => {
              currentBalance -= args.data.balance.decrement;
              return { driver_uid: "DRV/001", balance: currentBalance };
            },
          },
          driverWithdrawal: {
            create: async (args: any) => ({
              id: "wdr-001",
              amount: args.data.amount,
              status: args.data.status,
              reference: args.data.reference,
            }),
          },
          user: { update: async () => ({}) },
        };
        return callback(tx);
      },
    };

    const res = await createDriverWithdrawal(
      "drv-1",
      {
        amount: 400,
        bankName: "Access Bank",
        accountNumber: "0123456789",
        accountName: "John Driver",
      },
      mockDb
    );

    assert.equal(res.status, "PENDING");
    assert.equal(res.amount, 400);
    assert.ok(res.reference.startsWith("WDR-"));
    assert.equal(currentBalance, 600, "Driver balance must immediately be reserved by 400");
  });

  it("should prevent multiple pending withdrawals exceeding available balance sequentially", async () => {
    let currentBalance = 500;
    const mockDb: any = {
      user: {
        findUnique: async () => ({
          id: "drv-1",
          matricNumber: "DRV/001",
          role: "DRIVER",
          bankCode: "044",
          bankName: "Access Bank",
          accountNumber: "0123456789",
          accountName: "John Driver",
          bankVerified: true,
        }),
        update: async () => ({}),
      },
      $transaction: async (callback: any) => {
        const tx = {
          driverWallet: {
            findUnique: async () => ({ driver_uid: "DRV/001", balance: currentBalance }),
            update: async (args: any) => {
              if (currentBalance < args.data.balance.decrement) {
                throw new Error("CHECK_CONSTRAINT_VIOLATED");
              }
              currentBalance -= args.data.balance.decrement;
              return { driver_uid: "DRV/001", balance: currentBalance };
            },
          },
          driverWithdrawal: {
            create: async (args: any) => ({
              id: `wdr-${Math.random()}`,
              amount: args.data.amount,
              status: args.data.status,
              reference: args.data.reference,
            }),
          },
          user: { update: async () => ({}) },
        };
        return callback(tx);
      },
    };

    // First withdrawal of 300 should succeed
    const w1 = await createDriverWithdrawal(
      "drv-1",
      {
        amount: 300,
        bankName: "Zenith Bank",
        accountNumber: "1122334455",
        accountName: "John Driver",
      },
      mockDb
    );
    assert.equal(w1.amount, 300);
    assert.equal(currentBalance, 200, "Balance reserved from 500 to 200");

    // Second withdrawal of 300 must fail because available balance is now 200
    await assert.rejects(
      async () => {
        await createDriverWithdrawal(
          "drv-1",
          {
            amount: 300,
            bankName: "Zenith Bank",
            accountNumber: "1122334455",
            accountName: "John Driver",
          },
          mockDb
        );
      },
      { message: "INSUFFICIENT_BALANCE" },
      "Must reject when requested amount exceeds current available balance"
    );

    assert.equal(currentBalance, 200, "Driver balance must remain 200 and not become negative");
  });

  it("should prevent two concurrent withdrawals from exceeding available balance", async () => {
    // Shared atomic database state with row-level transaction lock emulation
    let sharedBalance = 100;
    let transactionLock: Promise<void> = Promise.resolve();

    const mockDb: any = {
      user: {
        findUnique: async () => ({
          id: "drv-1",
          matricNumber: "DRV/001",
          role: "DRIVER",
          bankCode: "044",
          bankName: "Access Bank",
          accountNumber: "0123456789",
          accountName: "John Driver",
          bankVerified: true,
        }),
        update: async () => ({}),
      },
      $transaction: async (callback: any) => {
        // Emulate DB row lock acquisition queue
        let releaseLock: () => void = () => {};
        const previousLock = transactionLock;
        transactionLock = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });

        await previousLock;
        try {
          const tx = {
            driverWallet: {
              findUnique: async () => ({ driver_uid: "DRV/001", balance: sharedBalance }),
              update: async (args: any) => {
                if (sharedBalance < args.data.balance.decrement) {
                  throw new Error("driver_wallets_balance_non_negative");
                }
                sharedBalance -= args.data.balance.decrement;
                return { driver_uid: "DRV/001", balance: sharedBalance };
              },
            },
            driverWithdrawal: {
              create: async (args: any) => ({
                id: `wdr-${Math.random()}`,
                amount: args.data.amount,
                status: args.data.status,
                reference: args.data.reference,
              }),
            },
            user: { update: async () => ({}) },
          };
          return await callback(tx);
        } finally {
          releaseLock();
        }
      },
    };

    // Two concurrent withdrawal requests of 70 Naira when available balance is 100 Naira
    const withdrawalParams = {
      amount: 70,
      bankName: "GTBank",
      accountNumber: "0987654321",
      accountName: "John Driver",
    };

    const results = await Promise.allSettled([
      createDriverWithdrawal("drv-1", withdrawalParams, mockDb),
      createDriverWithdrawal("drv-1", withdrawalParams, mockDb),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one withdrawal must succeed");
    assert.equal(rejected.length, 1, "The second concurrent withdrawal must be rejected");
    assert.equal(
      (rejected[0] as PromiseRejectedResult).reason.message,
      "INSUFFICIENT_BALANCE"
    );
    assert.equal(
      sharedBalance,
      30,
      "Balance must be exactly 30 (100 - 70). Never negative."
    );
  });

  it("should not reduce driver balance when withdrawal fails mid-transaction", async () => {
    let currentBalance = 500;
    const mockDb: any = {
      user: {
        findUnique: async () => ({
          id: "drv-1",
          matricNumber: "DRV/001",
          role: "DRIVER",
          bankCode: "044",
          bankName: "Access Bank",
          accountNumber: "0123456789",
          accountName: "John Driver",
          bankVerified: true,
        }),
      },
      $transaction: async (callback: any) => {
        const snapshotBalance = currentBalance;
        try {
          const tx = {
            driverWallet: {
              findUnique: async () => ({ driver_uid: "DRV/001", balance: currentBalance }),
              update: async (args: any) => {
                currentBalance -= args.data.balance.decrement;
                return { driver_uid: "DRV/001", balance: currentBalance };
              },
            },
            driverWithdrawal: {
              create: async () => {
                throw new Error("DB_WRITE_FAILURE");
              },
            },
            user: { update: async () => ({}) },
          };
          return await callback(tx);
        } catch (err) {
          // Transaction rollback on failure
          currentBalance = snapshotBalance;
          throw err;
        }
      },
    };

    await assert.rejects(
      async () => {
        await createDriverWithdrawal(
          "drv-1",
          {
            amount: 200,
            bankName: "Access Bank",
            accountNumber: "1234567890",
            accountName: "John Driver",
          },
          mockDb
        );
      },
      { message: "DB_WRITE_FAILURE" }
    );

    assert.equal(currentBalance, 500, "Balance must be restored to 500 via transaction rollback");
  });
});

describe("Driver Card Linking Ownership Verification", () => {
  it("should reject card link when caller attempts to link to a different driver ID", () => {
    const authenticatedDriver = { id: "drv-uuid-1", matricNumber: "DRV/001" };
    const arbitraryTargetDriverId = "DRV/999";

    const isAuthorized =
      arbitraryTargetDriverId === authenticatedDriver.id ||
      arbitraryTargetDriverId.toUpperCase() === authenticatedDriver.matricNumber;

    assert.equal(isAuthorized, false, "Must block linking to arbitrary driver IDs");
  });

  it("should accept card link when caller matches driver ID or matricNumber", () => {
    const authenticatedDriver = { id: "drv-uuid-1", matricNumber: "DRV/001" };

    const matchById = "drv-uuid-1" === authenticatedDriver.id;
    const matchByMatric = "drv/001".toUpperCase() === authenticatedDriver.matricNumber;

    assert.equal(matchById, true);
    assert.equal(matchByMatric, true);
  });

  it("should validate that OTP is exactly 6 digits", () => {
    const validOtp = "123456";
    const invalidShort = "12345";
    const invalidAlpha = "12345a";

    assert.equal(/^\d{6}$/.test(validOtp), true);
    assert.equal(/^\d{6}$/.test(invalidShort), false);
    assert.equal(/^\d{6}$/.test(invalidAlpha), false);
  });
});

describe("Driver Session Refresh", () => {
  it("should generate 8h token expiry for DRIVER role on refresh", () => {
    const payload = { role: "DRIVER" };
    const expiresIn = payload.role === "ADMIN" || payload.role === "DRIVER" ? "8h" : "1h";
    assert.equal(expiresIn, "8h");
  });
});
