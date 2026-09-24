# Kora Checkout Redirect Execution Plan

This document is the implementation contract for replacing student wallet
funding through virtual accounts or mock top-ups with Kora Checkout Redirect.
It is intentionally written as a sequence of gates. Do not begin the next
phase until the previous phase has passed its checks.

## 1. Final URL contract

### Frontend return route

The frontend must create this route:

```text
https://ctransit.me/payment/callback
```

Before the frontend route exists, this URL will return `404`. That is expected
until the frontend router is updated.

Kora appends the transaction reference when returning the customer:

```text
https://ctransit.me/payment/callback?reference=CTRANSIT-TOPUP-<unique-value>
```

The frontend callback page must not credit the wallet. It only displays the
payment state and asks the C-Transit API for the authoritative status.

### Backend webhook route

Kora sends the server-to-server notification to:

```text
https://c-transit-pink.vercel.app/api/payments/webhook
```

This route must be publicly reachable over HTTPS. It must not require a user
JWT or frontend cookie. It must verify Kora's signature using the raw request
body before changing wallet or payment state.

## 2. Confirmed Kora checkout contract

Kora Checkout Redirect initializes charges at:

```http
POST https://api.korapay.com/merchant/api/v1/charges/initialize
Authorization: Bearer <KORA_SECRET_KEY>
Content-Type: application/json
```

The backend request must contain:

```json
{
  "amount": 1500,
  "currency": "NGN",
  "reference": "CTRANSIT-TOPUP-unique-reference",
  "redirect_url": "https://ctransit.me/payment/callback",
  "notification_url": "https://c-transit-pink.vercel.app/api/payments/webhook",
  "narration": "C-Transit wallet top-up",
  "customer": {
    "email": "student@example.com",
    "name": "Student Name"
  }
}
```

The backend must enforce:

- currency: `NGN`
- minimum amount: `150`
- maximum amount: `10000`
- amount must be an integer number of naira
- reference must be unique
- customer details must come from the authenticated student

Kora success response:

```json
{
  "status": true,
  "message": "Charge created successfully",
  "data": {
    "reference": "CTRANSIT-TOPUP-unique-reference",
    "checkout_url": "https://checkout.korapay.com/reference/pay"
  }
}
```

The C-Transit API should normalize this to:

```json
{
  "success": true,
  "data": {
    "reference": "CTRANSIT-TOPUP-unique-reference",
    "checkoutUrl": "https://checkout.korapay.com/reference/pay",
    "status": "PENDING"
  }
}
```

Provider credentials must remain backend-only. The frontend must never receive
the Kora secret key or call Kora directly.

## 3. Payment persistence design

Create a dedicated `PaymentAttempt` model. Do not use the finalized ledger
transaction as the checkout-attempt record.

Recommended lifecycle:

```text
PENDING -> PROCESSING -> SUCCESS
                    -> FAILED
                    -> EXPIRED
                    -> CANCELLED
```

Recommended fields:

```text
id
reference (unique)
provider
providerReference
userId
amount
currency
status
failureReason
createdAt
updatedAt
completedAt
```

Responsibilities:

- `PaymentAttempt`: checkout lifecycle and provider reconciliation
- `Transaction`: finalized wallet ledger entry
- `Wallet`: current balance

The webhook must not create a second ledger transaction for the same reference.
The unique reference and database transaction are the final idempotency guard;
Redis is only the hot-path deduplication layer.

## 4. Backend endpoint contract

### Initialize checkout

```http
POST /api/payments/initialize
Authorization: Bearer <studentAccessToken>
Content-Type: application/json
```

Request:

```json
{ "amount": 1500 }
```

Behavior:

1. Authenticate the student.
2. Confirm the wallet is active.
3. Validate the amount range.
4. Create a unique pending `PaymentAttempt`.
5. Call Kora with the server-side secret.
6. Save the provider reference.
7. Return `checkoutUrl` and the internal reference.

### Payment status

```http
GET /api/payments/status/:reference
Authorization: Bearer <studentAccessToken>
```

The endpoint must only return attempts belonging to the authenticated student.

Response:

```json
{
  "success": true,
  "data": {
    "reference": "CTRANSIT-TOPUP-unique-reference",
    "amount": 1500,
    "currency": "NGN",
    "status": "SUCCESS",
    "completedAt": "2026-09-24T12:00:00.000Z"
  }
}
```

### Webhook

```http
POST /api/payments/webhook
```

This is server-to-server only. The route must:

1. Capture the exact raw body.
2. Read the Kora signature header.
3. Verify the signature against the raw body.
4. Validate the event and required payment fields.
5. Locate the `PaymentAttempt` by reference.
6. Ignore already finalized attempts safely.
7. Atomically mark the attempt successful and create the ledger transaction.
8. Credit the wallet exactly once.
9. Return a successful acknowledgement after durable processing.

The frontend redirect must never be treated as proof of payment.

## 5. Frontend execution contract

The frontend team must implement these states:

1. Amount form rejects values below `150` or above `10000`.
2. Submit calls `/api/payments/initialize`.
3. Loading state prevents duplicate submissions.
4. Browser redirects to the returned `data.checkoutUrl`.
5. `/payment/callback` reads the `reference` query parameter.
6. Callback page shows `Payment processing` initially.
7. Callback page calls `/api/payments/status/:reference`.
8. `SUCCESS` refreshes wallet details and shows the new balance.
9. `PENDING` or `PROCESSING` polls with bounded retry/backoff.
10. `FAILED`, `CANCELLED`, `EXPIRED`, or timeout shows retry guidance.

The frontend must not:

- call Kora directly
- include Kora keys in frontend configuration
- credit the wallet after redirect
- assume redirect means success
- call `/api/payments/topup`
- call provider webhook routes

## 6. Implementation order

### Phase A: Contract and schema

- Add `PaymentAttemptStatus` and `PaymentAttempt` migration.
- Generate Prisma Client.
- Apply the migration to the development database.
- Confirm the migration is present in Git and deployment artifacts.

Gate: build passes and Prisma migration status is clean.

### Phase B: Provider adapter

- Add `initializeCheckout` to `IPaymentGateway`.
- Implement Kora Checkout Redirect initialization.
- Validate the Kora response at runtime.
- Reject missing or malformed `checkout_url` values.
- Keep virtual-account methods available only for compatibility during rollout.

Gate: provider unit tests cover success, rejected charge, malformed response,
timeout, and duplicate reference behavior.

### Phase C: Backend API

- Add `/api/payments/initialize`.
- Add `/api/payments/status/:reference`.
- Add payment-attempt persistence and ownership checks.
- Replace parsed-body webhook signature verification with raw-body verification.
- Keep mock top-up disabled outside local development.

Gate: integration tests cover authentication, amount limits, ownership,
idempotency, webhook success, duplicate webhook, and failed payment.

### Phase D: Frontend callback

- Add the `/payment/callback` route to the frontend application.
- Add loading, pending, success, failure, and timeout states.
- Connect the callback to the status endpoint.
- Refresh wallet data only after backend status is `SUCCESS`.

Gate: the deployed callback URL loads without `404` and works after a Kora
sandbox redirect.

### Phase E: Sandbox end-to-end test

- Use Kora test-mode keys only.
- Configure the notification URL in Kora.
- Initialize a payment for `150`.
- Initialize a payment for `10000`.
- Verify `149` and `10001` are rejected locally.
- Complete a sandbox checkout.
- Confirm webhook signature acceptance.
- Confirm exactly one wallet credit.
- Replay the webhook and confirm no second credit.
- Confirm the callback status transitions correctly.

Gate: all sandbox tests pass and database ledger totals match wallet balance.

### Phase F: Production readiness

- Replace test keys with rotated live keys in the deployment secret manager.
- Set production callback and webhook URLs.
- Confirm PostgreSQL and Redis connectivity.
- Apply migrations with `prisma migrate deploy`.
- Run build and tests.
- Perform one controlled low-value live verification only after approval.

## 7. URL checklist

| Purpose | URL |
| --- | --- |
| Frontend return route | `https://ctransit.me/payment/callback` |
| Backend webhook | `https://c-transit-pink.vercel.app/api/payments/webhook` |
| Kora initialize endpoint | `https://api.korapay.com/merchant/api/v1/charges/initialize` |

The frontend return route must be implemented before it is supplied to Kora.
The backend webhook must be deployed and externally reachable before sandbox
checkout testing begins.