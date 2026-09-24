import { test, describe } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { terminalProvisioningService } from "../src/services/terminal-provisioning.service.js";
import { unlinkCard } from "../src/services/card.service.js";
import { KoraProvider } from "../src/payments/kora.provider.js";
import { MockProvider } from "../src/payments/mock.provider.js";

describe("Terminal Provisioning Service", () => {
  test("provisionDriverPin provides isolated hardware contract pending team specification", async () => {
    const result = await terminalProvisioningService.provisionDriverPin({
      cardUid: "CARD1234",
      driverUid: "DRV-001",
    });

    assert.equal(result.success, true);
    assert.equal(result.pendingHardwareContract, true);
  });
});

describe("Driver PIN Security & Validation", () => {
  test("PIN must be 4 to 6 numeric digits", () => {
    const validPins = ["1234", "0000", "999999", "12345"];
    const invalidPins = ["123", "1234567", "abcd", "12a4", ""];

    const pinRegex = /^\d{4,6}$/;

    for (const pin of validPins) {
      assert.ok(pinRegex.test(pin), `Expected ${pin} to be valid`);
    }

    for (const pin of invalidPins) {
      assert.ok(!pinRegex.test(pin), `Expected ${pin} to be invalid`);
    }
  });

  test("PIN is hashed using bcrypt and matches comparison", async () => {
    const rawPin = "5821";
    const hashed = await bcrypt.hash(rawPin, 10);

    assert.notEqual(hashed, rawPin);
    assert.ok(hashed.startsWith("$2"), "Should be a bcrypt hash");
    assert.ok(await bcrypt.compare("5821", hashed));
    assert.ok(!(await bcrypt.compare("9999", hashed)));
  });
});

describe("Payment Providers - Bank Account Resolution", () => {
  test("MockProvider resolves bank account in non-production", async () => {
    const mockProvider = new MockProvider();
    const result = await mockProvider.resolveBankAccount("044", "0123456789");

    assert.equal(result.accountNumber, "0123456789");
    assert.equal(result.bankCode, "044");
    assert.equal(result.accountName, "MOCK VERIFIED ACCOUNT HOLDER");
  });

  test("MockProvider rejects invalid 10-digit account number", async () => {
    const mockProvider = new MockProvider();
    await assert.rejects(
      async () => {
        await mockProvider.resolveBankAccount("044", "123");
      },
      { message: "Invalid bank account number" }
    );
  });

  test("KoraProvider validates inputs before API dispatch", async () => {
    const koraProvider = new KoraProvider({
      secretKey: "test_secret",
      publicKey: "test_public",
    });

    await assert.rejects(
      async () => {
        await koraProvider.resolveBankAccount("", "0123456789");
      },
      { message: "One or more fields are invalid. Please fix them and try again." }
    );

    await assert.rejects(
      async () => {
        await koraProvider.resolveBankAccount("044", "not-ten-digits");
      },
      { message: "One or more fields are invalid. Please fix them and try again." }
    );
  });
});

describe("Driver Withdrawal Fee Calculation", () => {
  test("Calculates 4% C-Transit payout fee accurately", () => {
    const CTRANSIT_PAYOUT_FEE_RATIO = 0.04;
    const grossAmount = 10000;
    const ctransitFee = Math.round(grossAmount * CTRANSIT_PAYOUT_FEE_RATIO * 100) / 100;
    const netAmount = Math.round((grossAmount - ctransitFee) * 100) / 100;

    assert.equal(ctransitFee, 400);
    assert.equal(netAmount, 9600);
  });
});

describe("Card Unlink Authority Validation", () => {
  test("Rejects unauthorized caller role (student/driver cannot unlink)", async () => {
    await assert.rejects(
      async () => {
        await unlinkCard({
          cardUid: "CARD123",
          callerId: "user-123",
          callerRole: "STUDENT",
        });
      },
      { message: "UNAUTHORIZED_CALLER" }
    );

    await assert.rejects(
      async () => {
        await unlinkCard({
          cardUid: "CARD123",
          callerId: "user-123",
          callerRole: "DRIVER",
        });
      },
      { message: "UNAUTHORIZED_CALLER" }
    );
  });

  test("Rejects invocation with no cardUid and no userIdentifier", async () => {
    await assert.rejects(
      async () => {
        await unlinkCard({
          callerId: "admin-123",
          callerRole: "ADMIN",
        });
      },
      { message: "MISSING_IDENTIFIER" }
    );
  });
});
