/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  REQUIRED_PRODUCTION_SECRETS,
  INSECURE_FALLBACK_SECRETS,
  validateProductionSecrets,
} from "../src/config/env.js";
import { KoraProvider } from "../src/payments/kora.provider.js";
import { MockProvider } from "../src/payments/mock.provider.js";
import { handleDriverPayoutWebhook } from "../src/services/driver.service.js";
import {
  authenticateToken,
  requireDriver,
  requireAdmin,
  requireAgent,
  requireStudent,
  requireAdminOrAgent,
} from "../src/middleware/auth.middleware.js";
import { handlePaymentWebhook } from "../src/controller/webhook.controller.js";
import { requireStudentAuth } from "../src/controller/wallets.controller.js";

function createMockRes() {
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
  return res;
}

describe("Production Security Hardening — Secrets & Environment Validation", () => {
  it("should fail when required production secrets are completely missing", () => {
    assert.throws(
      () => {
        validateProductionSecrets({});
      },
      (err: Error) => {
        return (
          err.message.includes("FATAL: Missing or insecure required production secrets") &&
          REQUIRED_PRODUCTION_SECRETS.every((key) => err.message.includes(key))
        );
      }
    );
  });

  it("should fail when any single required production secret is missing", () => {
    const fullValidEnv: Record<string, string> = {
      DATABASE_URL: "postgresql://postgres:prodpass@db.example.com:5432/ctransit",
      REDIS_URL: "redis://default:prodpass@redis.example.com:6379",
      ADMIN_API_SECRET: "prod_admin_secret_xyz987654321",
      JWT_SECRET: "prod_jwt_secret_xyz987654321_strong",
      JWT_REFRESH_SECRET: "prod_jwt_refresh_xyz987654321_strong",
      OTP_SECRET: "prod_otp_secret_xyz987654321",
      PAYMENT_SECRET_KEY: "prod_kora_secret_xyz987654321",
      MQTT_INTERNAL_SECRET: "prod_mqtt_secret_xyz987654321",
    };

    for (const secretKey of REQUIRED_PRODUCTION_SECRETS) {
      const partialEnv = { ...fullValidEnv };
      delete partialEnv[secretKey];

      assert.throws(
        () => {
          validateProductionSecrets(partialEnv);
        },
        (err: Error) => {
          return err.message.includes(secretKey);
        },
        `Expected validation to fail when ${secretKey} is missing`
      );
    }
  });

  it("should fail in production if insecure development fallback secrets are used", () => {
    const insecureEnv: Record<string, string> = {
      DATABASE_URL: "postgresql://postgres:prodpass@db.example.com:5432/ctransit",
      REDIS_URL: "redis://default:prodpass@redis.example.com:6379",
      ADMIN_API_SECRET: INSECURE_FALLBACK_SECRETS.ADMIN_API_SECRET,
      JWT_SECRET: "prod_jwt_secret_xyz987654321_strong",
      JWT_REFRESH_SECRET: "prod_jwt_refresh_xyz987654321_strong",
      OTP_SECRET: "prod_otp_secret_xyz987654321",
      PAYMENT_SECRET_KEY: "prod_kora_secret_xyz987654321",
      MQTT_INTERNAL_SECRET: "prod_mqtt_secret_xyz987654321",
    };

    assert.throws(
      () => {
        validateProductionSecrets(insecureEnv);
      },
      (err: Error) => {
        return err.message.includes("ADMIN_API_SECRET");
      }
    );
  });

  it("should pass when all production secrets are securely provided", () => {
    const validEnv: Record<string, string> = {
      DATABASE_URL: "postgresql://postgres:prodpass@db.example.com:5432/ctransit",
      REDIS_URL: "redis://default:prodpass@redis.example.com:6379",
      ADMIN_API_SECRET: "prod_admin_secret_xyz987654321",
      JWT_SECRET: "prod_jwt_secret_xyz987654321_strong",
      JWT_REFRESH_SECRET: "prod_jwt_refresh_xyz987654321_strong",
      OTP_SECRET: "prod_otp_secret_xyz987654321",
      PAYMENT_SECRET_KEY: "prod_kora_secret_xyz987654321",
      MQTT_INTERNAL_SECRET: "prod_mqtt_secret_xyz987654321",
    };

    assert.doesNotThrow(() => {
      validateProductionSecrets(validEnv);
    });
  });
});

describe("Production Security Hardening — Role Authorization & RBAC", () => {
  it("authenticateToken should reject missing or invalid authorization header with 401 or 403", () => {
    const res = createMockRes();
    let nextCalled = false;

    // Missing token
    authenticateToken({ headers: {}, ip: "127.0.0.1", path: "/api/drivers/me" } as any, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);

    // Invalid token
    nextCalled = false;
    authenticateToken(
      { headers: { authorization: "Bearer invalid.token.value" }, ip: "127.0.0.1", path: "/api/drivers/me" } as any,
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("requireDriver should strictly reject non-DRIVER roles with 403", () => {
    const res = createMockRes();

    for (const role of ["STUDENT", "AGENT", "ADMIN", "ANONYMOUS"]) {
      let nextCalled = false;
      requireDriver({ user: { userId: "user-1", role }, path: "/api/drivers/me" } as any, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, `Role ${role} must not access driver endpoints`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, "Driver access required");
    }

    // Must allow DRIVER
    let driverNext = false;
    requireDriver({ user: { userId: "user-1", role: "DRIVER" } } as any, res, () => {
      driverNext = true;
    });
    assert.equal(driverNext, true);
  });

  it("requireAdmin should strictly reject non-ADMIN roles with 403", () => {
    const res = createMockRes();

    for (const role of ["STUDENT", "DRIVER", "AGENT"]) {
      let nextCalled = false;
      requireAdmin({ user: { userId: "user-1", role }, path: "/api/admin/overview" } as any, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, `Role ${role} must not access admin endpoints`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, "Admin access required");
    }

    // Must allow ADMIN
    let adminNext = false;
    requireAdmin({ user: { userId: "admin-1", role: "ADMIN" } } as any, res, () => {
      adminNext = true;
    });
    assert.equal(adminNext, true);
  });

  it("requireAgent should strictly reject non-AGENT roles with 403", () => {
    const res = createMockRes();

    for (const role of ["STUDENT", "DRIVER", "ADMIN"]) {
      let nextCalled = false;
      requireAgent({ user: { userId: "user-1", role }, path: "/api/agents/me" } as any, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, `Role ${role} must not access agent endpoints`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, "Agent access required");
    }

    // Must allow AGENT
    let agentNext = false;
    requireAgent({ user: { userId: "agent-1", role: "AGENT" } } as any, res, () => {
      agentNext = true;
    });
    assert.equal(agentNext, true);
  });

  it("requireStudent should strictly reject non-STUDENT roles with 403", () => {
    const res = createMockRes();

    for (const role of ["DRIVER", "AGENT", "ADMIN"]) {
      let nextCalled = false;
      requireStudent({ user: { userId: "user-1", role }, path: "/api/transactions/history" } as any, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, `Role ${role} must not access student endpoints`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, "Student access required");
    }

    // Must allow STUDENT
    let studentNext = false;
    requireStudent({ user: { userId: "student-1", role: "STUDENT" } } as any, res, () => {
      studentNext = true;
    });
    assert.equal(studentNext, true);
  });

  it("requireAdminOrAgent should reject STUDENT and DRIVER roles with 403", () => {
    const res = createMockRes();

    for (const role of ["STUDENT", "DRIVER"]) {
      let nextCalled = false;
      requireAdminOrAgent({ user: { userId: "user-1", role }, path: "/api/users" } as any, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, "Admin or Agent access required");
    }

    // Must allow ADMIN and AGENT
    let adminNext = false;
    requireAdminOrAgent({ user: { userId: "admin-1", role: "ADMIN" } } as any, res, () => {
      adminNext = true;
    });
    assert.equal(adminNext, true);

    let agentNext = false;
    requireAdminOrAgent({ user: { userId: "agent-1", role: "AGENT" } } as any, res, () => {
      agentNext = true;
    });
    assert.equal(agentNext, true);
  });

  it("requireStudentAuth should reject non-STUDENT roles with 403 and unauthenticated with 401", () => {
    const res = createMockRes();

    let unauthNext = false;
    requireStudentAuth({ user: undefined } as any, res, () => {
      unauthNext = true;
    });
    assert.equal(unauthNext, false);
    assert.equal(res.statusCode, 401);

    let driverNext = false;
    requireStudentAuth({ user: { userId: "drv-1", role: "DRIVER" } } as any, res, () => {
      driverNext = true;
    });
    assert.equal(driverNext, false);
    assert.equal(res.statusCode, 403);
  });
});

describe("Production Security Hardening — Kora Webhook Signature Verification", () => {
  const secretKey = "kora_secret_test_key_123456789";
  const kora = new KoraProvider(secretKey);

  const payload = JSON.stringify({
    event: "transfer.success",
    data: {
      reference: "WDR-TEST-SIGNATURE-001",
      status: "success",
      amount: 1000,
      fee: 25,
    },
  });

  it("should accept valid HMAC sha512 signature", () => {
    const validSignature = crypto
      .createHmac("sha512", secretKey)
      .update(payload)
      .digest("hex");

    const isValid = kora.verifyWebhook(payload, validSignature);
    assert.equal(isValid, true);
  });

  it("should reject invalid, forged, or altered signatures", () => {
    const invalidSignature = "abcde1234567890fbaddecafbaddecafbaddecaf";
    assert.equal(kora.verifyWebhook(payload, invalidSignature), false);

    const wrongKeySignature = crypto
      .createHmac("sha512", "different_secret_key")
      .update(payload)
      .digest("hex");
    assert.equal(kora.verifyWebhook(payload, wrongKeySignature), false);
  });

  it("should reject empty, null, or missing signatures", () => {
    assert.equal(kora.verifyWebhook(payload, ""), false);
  });

  it("handlePaymentWebhook should reject requests missing signature header with 401", async () => {
    const req = {
      headers: {},
      body: { event: "charge.success", data: {} },
    };
    const res = createMockRes();

    await handlePaymentWebhook(req as any, res);
    assert.equal(res.statusCode, 401);
  });

  it("handlePaymentWebhook should reject requests with invalid signature with 401", async () => {
    const req = {
      headers: { "x-korapay-signature": "invalid_signature" },
      body: { event: "charge.success", data: {} },
    };
    const res = createMockRes();

    await handlePaymentWebhook(req as any, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, "Cryptographic signature validation failed.");
  });

  it("MockProvider should also reject missing or invalid signatures", () => {
    const mockProvider = new MockProvider();
    assert.equal(mockProvider.verifyWebhook("{}", ""), false);
    assert.equal(mockProvider.verifyWebhook("{}", "invalid_signature"), false);
  });
});

describe("Production Security Hardening — Withdrawal Webhook Idempotency", () => {
  it("should be idempotent when webhook is repeated on an already SUCCESS withdrawal", async () => {
    const withdrawalId = "wdr-perm-succ";
    const driverUid = "DRV/IDEMP";
    let walletBalance = 0;

    const dbMock: any = {
      driverWithdrawal: {
        findFirst: async () => ({
          id: withdrawalId,
          reference: "WDR-IDEMP-001",
          driver_uid: driverUid,
          status: "SUCCESS",
          amount: 1000,
        }),
      },
      driverWallet: {
        update: async () => {
          walletBalance += 1000;
        },
      },
    };

    const firstResult = await handleDriverPayoutWebhook(
      {
        reference: "WDR-IDEMP-001",
        koraReference: "KORA-REF-1",
        event: "transfer.success",
        status: "success",
      },
      dbMock
    );

    assert.equal(firstResult.success, true);
    assert.equal(firstResult.message, "Withdrawal already marked SUCCESS");
    assert.equal(walletBalance, 0); // Balance untouched
  });

  it("should be idempotent when webhook is repeated on an already FAILED withdrawal", async () => {
    const withdrawalId = "wdr-perm-fail";
    const driverUid = "DRV/IDEMP-FAIL";
    let walletRestoreCount = 0;

    const dbMock: any = {
      driverWithdrawal: {
        findFirst: async () => ({
          id: withdrawalId,
          reference: "WDR-IDEMP-FAIL-001",
          driver_uid: driverUid,
          status: "FAILED",
          amount: 500,
        }),
      },
      driverWallet: {
        update: async () => {
          walletRestoreCount++;
        },
      },
    };

    const repeatedResult = await handleDriverPayoutWebhook(
      {
        reference: "WDR-IDEMP-FAIL-001",
        koraReference: "KORA-REF-2",
        event: "transfer.failed",
        status: "failed",
      },
      dbMock
    );

    assert.equal(repeatedResult.success, true);
    assert.equal(repeatedResult.message, "Withdrawal already marked FAILED");
    assert.equal(walletRestoreCount, 0); // Not restored again!
  });
});

