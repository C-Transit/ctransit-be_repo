import crypto from "node:crypto";

const backendUrl = (
  process.env.BACKEND_URL || "https://c-transit-pink.vercel.app"
).replace(/\/+$/, "");
const secret = process.env.KORA_SECRET_KEY?.trim();
const reference =
  process.env.WITHDRAWAL_REFERENCE || `WDR-WEBHOOK-TEST-${Date.now()}`;

if (!secret) {
  console.error("Set KORA_SECRET_KEY in the environment first.");
  process.exit(1);
}

const data = {
  reference,
  status: "success",
  amount: 1000,
  currency: "NGN",
  fee: 40,
};

const signature = crypto
  .createHmac("sha256", secret)
  .update(JSON.stringify(data))
  .digest("hex");

const response = await fetch(`${backendUrl}/api/payments/payout-webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-korapay-signature": signature,
  },
  body: JSON.stringify({
    event: "transfer.success",
    data,
  }),
});

console.log(`HTTP ${response.status}`);
console.log(await response.text());
console.log(
  `\nSent a signed test webhook for reference: ${reference}\n` +
    "If the reference does not exist, a 200 response still proves the signature and route are working."
);
