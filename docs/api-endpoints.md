# C-Transit API Endpoint Reference

This is the machine-integration contract for the C-Transit frontend. Google AI
Studio or any other client generator must use the paths, field names, casing,
and response wrappers in this document exactly. Do not invent alternate payload
keys such as `user_id`, `firstName`, `phoneNumber`, `transaction_id`, or
`statusCode` unless an endpoint explicitly documents them.

## Integration rules

- The API base URL is provided by the deployment environment as
  `API_BASE_URL`; do not hard-code localhost in the frontend.
- Use JSON for all requests except `POST /api/kyc/submit`, which is multipart.
- Send `Authorization: Bearer <accessToken>` only after a successful login.
- Store access and refresh tokens according to the frontend's security policy;
  never expose provider keys, admin secrets, terminal secrets, or database
  credentials in frontend code, browser bundles, or public environment values.
- Treat the response wrapper as part of the contract. For example,
  transaction history is under `data.transactions`, while KYC status is the
  scalar `data` value.
- On `401`, refresh once with `/api/auth/refresh`; if refresh fails, clear the
  session and return the user to login. On `403`, show an authorization error;
  do not retry with a different role or secret.
- Do not call webhook or internal settlement endpoints from a browser. They are
  server-to-server endpoints.

### Standard response conventions

Successful responses commonly include `success: true`, `message`, `data`, or a
resource-specific field. The endpoint sections below specify the authoritative
shape where it differs. Error responses are JSON and should be handled by HTTP
status first; clients must not assume every error has the same message shape.

Common status meanings:

| Status | Meaning |
| --- | --- |
| `200` | Successful read or update |
| `201` | Successful creation |
| `400` | Invalid payload, query, or business rule |
| `401` | Missing or invalid JWT |
| `403` | Valid identity without required role/permission |
| `404` | Resource does not exist |
| `409` | Duplicate or conflicting operation |
| `429` | Rate limit exceeded |
| `500` | Server or dependency failure |

This document lists the user, driver, admin, and agent HTTP endpoints currently registered by the Express application.

## Base URL and headers

The server accepts either the deployed API origin or a local origin. Replace `API_BASE_URL` in examples with the actual origin.

Common JSON request headers:

```http
Content-Type: application/json
```

JWT-protected requests also require:

```http
Authorization: Bearer <accessToken>
```

Multipart KYC requests use:

```http
Content-Type: multipart/form-data
Authorization: Bearer <studentAccessToken>
```

JWT-protected admin operations require:

```http
Authorization: Bearer <adminAccessToken>
```

Secret-gated admin system requests additionally require a backend-only secret:

```http
x-admin-secret: <ADMIN_API_SECRET>
```

In production, the server may use `x-backend-secret` instead of
`x-admin-secret`, according to the server environment configuration. This
header must never be sent by a public frontend. These routes also require an
`ADMIN` JWT; the secret alone is not sufficient.

The poison-pill route additionally requires:

```http
x-critical-approval-token: <CRITICAL_ADMIN_APPROVAL_TOKEN>
x-admin-id: <admin-id-for-audit>
```

Payment webhooks require the provider signature header:

```http
x-korapay-signature: <signature>
```

or:

```http
fincra-signature: <signature>
```

All requests are subject to the global rate limiter. Login, registration, OTP, KYC, transaction, wallet, dispute, notification, and driver-login routes may have additional rate limits.

## Route aliases

The application mounts the following equivalent prefixes:

- `/admin` and `/api/admin`
- `/health` and `/api/health`
- Agent routes are available under `/api/agents/...` and `/api/auth/agent/...`

Examples below use `/api/...` as the primary prefix.

The following routes are public infrastructure routes:

```http
GET /
GET /health
GET /api/health
```

`GET /` returns a plain-text liveness message. The health routes return an
object with `status`, `environment`, `uptimeSeconds`, `timestamp`, and
`checks`. Do not use a health response as an authentication response.

## Authentication

### Register student

```http
POST /api/auth/register
```

Headers: `Content-Type: application/json`

Body:

```json
{
  "firstname": "Ada",
  "lastname": "Lovelace",
  "email": "ada@covenantuniversity.edu.ng",
  "matricNumber": "CU/001",
  "password": "StrongPass1"
}
```

Password must be at least 8 characters and contain uppercase, lowercase, and a number. The email must use the configured institution domain.

### Verify registration OTP

```http
POST /api/auth/verify-otp
```

Body:

```json
{ "email": "ada@covenantuniversity.edu.ng", "otp": "123456" }
```

### Resend registration OTP

```http
POST /api/auth/resend-otp
```

Body:

```json
{ "email": "ada@covenantuniversity.edu.ng" }
```

### Student login

```http
POST /api/auth/login
```

Body:

```json
{ "email": "ada@covenantuniversity.edu.ng", "password": "StrongPass1" }
```

Success returns `accessToken` and `refreshToken`.

The successful response uses these top-level fields:

```json
{
  "message": "Login successful",
  "accessToken": "access-jwt",
  "refreshToken": "refresh-jwt"
}
```

### Admin login

```http
POST /api/auth/admin/login
```

Body:

```json
{ "email": "admin@example.com", "password": "StrongPass1" }
```

Success returns an 8-hour `accessToken` and a `refreshToken`. No Bearer token is required.

### Agent login

```http
POST /api/agents/login
POST /api/auth/agent/login
```

Body:

```json
{ "email": "agent@example.com", "password": "StrongPass1" }
```

Success returns `token`, `accessToken`, `refreshToken`, and `agent`.

### Driver login

```http
POST /api/drivers/login
```

Headers: JSON content type. This route is rate limited.

Body:

```json
{ "identifier": "DRIVER/001", "password": "StrongPass1" }
```

`identifier` may be the driver's email or driver ID. Success returns `token`, `accessToken`, `refreshToken`, and `driver`.

### Refresh access token

```http
POST /api/auth/refresh
```

No access token is required.

Body:

```json
{ "refreshToken": "<refresh-jwt>" }
```

Success returns `accessToken` and the compatibility alias `token`:

```json
{
  "accessToken": "new-access-jwt",
  "token": "new-access-jwt"
}
```

### Logout

```http
POST /api/auth/logout
```

No access token is required.

Body:

```json
{ "refreshToken": "<refresh-jwt>" }
```

### Confirm student card

```http
POST /api/auth/confirm-card
```

Access: authenticated student JWT.

Body:

```json
{ "otp": "123456" }
```

`otp` must be exactly six digits.

### Card-link status

```http
GET /api/auth/card-link-status
```

Access: authenticated JWT.

Headers: `Authorization: Bearer <accessToken>`.

No request body.

## User and student endpoints

### Get user count

```http
GET /api/users/count
```

Access: authenticated `ADMIN` or `AGENT` JWT.

### List users

```http
GET /api/users
```

Access: authenticated `ADMIN` or `AGENT` JWT.

No request fields.

### Get own profile

```http
GET /api/users/myprofile
```

Access: authenticated JWT.

### Update own profile

```http
PATCH /api/users/update-profile
```

Access: authenticated JWT.

Body, at least one field required:

```json
{ "firstname": "Ada", "lastname": "Byron" }
```

### Change own password

```http
PATCH /api/users/change-password
```

Access: authenticated JWT.

Body:

```json
{
  "currentPassword": "OldPass1",
  "newPassword": "NewPass2"
}
```

### Request password reset

```http
POST /api/users/forgot-password
```

No access token required.

Body:

```json
{ "email": "ada@covenantuniversity.edu.ng" }
```

### Reset password with OTP

```http
POST /api/users/reset-password
```

No access token required.

Body:

```json
{
  "email": "ada@covenantuniversity.edu.ng",
  "otp": "123456",
  "newPassword": "NewPass2"
}
```

### Link student wallet/card

```http
POST /api/wallets/link
```

Access: authenticated `STUDENT` JWT.

Body:

```json
{ "otp": "123456" }
```

### Get wallet details

```http
GET /api/wallets/details
```

Access: authenticated `STUDENT` JWT.

Response shape:

```json
{
  "success": true,
  "data": {
    "balance": 1500,
    "accountNumber": "0123456789",
    "bank": "Example Bank",
    "bankName": "Example Bank"
  }
}
```

### Get transaction history

```http
GET /api/transactions/history?limit=20&cursor=<transaction-id>
```

Access: authenticated `STUDENT` JWT.

Query fields:

- `limit`: optional page size.
- `cursor`: optional pagination cursor.

Response shape:

```json
{
  "success": true,
  "data": {
    "transactions": [],
    "nextCursor": "next-transaction-id",
    "hasMore": false,
    "count": 0
  }
}
```

When there is no next page, `nextCursor` may be `null`. Send its value back
unchanged as the next request's `cursor`; do not use page numbers here.

### Submit KYC

```http
POST /api/kyc/submit
```

Access: authenticated `STUDENT` JWT. Use `multipart/form-data`; do not send a
JSON body. The only consumed field is a file named exactly `idCard`.

Constraints:

- Accepted file types: JPEG, PNG, or WEBP.
- Maximum file size: 5 MB.
- No text fields are required or consumed.

```bash
curl -X POST "$API_BASE_URL/api/kyc/submit" \
  -H "Authorization: Bearer $STUDENT_ACCESS_TOKEN" \
  -F "idCard=@id-card.jpg"
```

Success shape:

```json
{
  "message": "KYC submitted successfully",
  "data": { "kycId": "kyc-record-id" }
}
```

### Get own KYC status

```http
GET /api/kyc/status
```

Access: authenticated `STUDENT` JWT.

The response uses a scalar `data` value, not `data.status`:

```json
{ "data": "PENDING", "message": "KYC status retrieved" }
```

### Get own notifications

```http
GET /api/notifications
```

Access: authenticated `STUDENT` JWT.

### Mark all notifications read

```http
PATCH /api/notifications/mark-all-read
```

Access: authenticated `STUDENT` JWT.

### Mark one notification read

```http
PATCH /api/notifications/:id/mark-read
```

Access: authenticated `STUDENT` JWT.

Path field: `id` is the notification ID.

### Raise a dispute

```http
POST /api/disputes
```

Access: authenticated `STUDENT` JWT.

Body:

```json
{
  "transactionId": "transaction-id",
  "description": "The fare charged on this ride was incorrect."
}
```

The description must contain at least 10 characters.

### List own disputes

```http
GET /api/disputes
```

Access: authenticated `STUDENT` JWT.

### Request virtual account

```http
POST /api/payments/create
```

Access: authenticated `STUDENT` JWT. The wallet must be activated/KYC-complete.

No request body.

Response shape:

```json
{
  "success": true,
  "message": "Virtual account created",
  "data": {
    "accountNumber": "0123456789",
    "bankName": "Example Bank",
    "reference": "provider-reference"
  }
}
```

### Initialize Kora Checkout Redirect

```http
POST /api/payments/initialize
```

Access: authenticated `STUDENT` JWT.

The backend creates a unique payment attempt and initializes Kora Checkout
Redirect. The frontend must send only the amount; it must not send provider
keys, customer identity, or a payment reference.

Body:

```json
{ "amount": 1500 }
```

Constraints:

- Currency is fixed to `NGN`.
- Amount must be an integer from `150` through `10000`, inclusive.
- The student's wallet must be activated.

Success response:

```json
{
  "success": true,
  "data": {
    "reference": "CTRANSIT-TOPUP-unique-uuid",
    "checkoutUrl": "https://checkout.korapay.com/reference/pay",
    "status": "PENDING"
  }
}
```

The frontend should redirect the browser to `data.checkoutUrl`. Kora returns
the user to `https://ctransit.me/dashboard?reference=<reference>`. The
dashboard must read the reference, query the status endpoint, and then remove
the query string from the browser history. A redirect is not proof of payment;
the signed backend webhook is authoritative.

### Get Kora checkout status

```http
GET /api/payments/status/:reference
```

Access: authenticated `STUDENT` JWT. The requested payment reference must
belong to the authenticated student.

Success response:

```json
{
  "success": true,
  "data": {
    "reference": "CTRANSIT-TOPUP-unique-uuid",
    "amount": 1500,
    "currency": "NGN",
    "status": "SUCCESS",
    "completedAt": "2026-09-24T12:00:00.000Z"
  }
}
```

Possible statuses are `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`,
`CANCELLED`, and `EXPIRED`.

### Frontend dashboard return handling

The Kora redirect returns the browser to:

```text
https://ctransit.me/dashboard?reference=<payment-reference>
```

This is a frontend browser URL, not a backend API endpoint. The dashboard must:

1. Read the `reference` query parameter after the user returns from Kora.
2. Keep the user on the dashboard and show a processing state.
3. Call `GET /api/payments/status/:reference` with the student's JWT.
4. Treat only `data.status === "SUCCESS"` as confirmed payment.
5. Refresh `GET /api/wallets/details` after success.
6. Poll only while the status is `PENDING` or `PROCESSING`, with bounded retries.
7. Show a retry/error state for `FAILED`, `CANCELLED`, `EXPIRED`, `401`, `404`,
   or a polling timeout.
8. Remove the reference from the browser URL after handling it:

```js
window.history.replaceState({}, document.title, "/dashboard");
```

The reference is an opaque identifier, not a secret. The API still requires
the authenticated student JWT and verifies that the attempt belongs to that
student. Never use the reference alone as authorization.

### Fetch virtual account and balance

```http
GET /api/payments/fetch
```

Access: authenticated `STUDENT` JWT.

Response shape:

```json
{
  "success": true,
  "data": {
    "accountNumber": "0123456789",
    "bankName": "Example Bank",
    "balance": 1500
  }
}
```

### Mock top-up

```http
POST /api/payments/topup
```

Access: authenticated `STUDENT` JWT and only available when the mock payment provider is explicitly enabled.

Body:

```json
{ "amount": 1500 }
```

`amount` must be a positive number.

Success shape when mock payments are explicitly enabled:

```json
{
  "success": true,
  "message": "Wallet topped up successfully",
  "data": {
    "reference": "mock-reference",
    "amount": 1500,
    "newBalance": 1500
  }
}
```

### Provider migration: Mock or virtual account to Checkout Redirect

This is the only payment UI flow that a generated frontend must replace when
moving from mock payments to Kora payments.

| Mock flow | Kora flow |
| --- | --- |
| `POST /api/payments/topup` with `{ "amount": 1500 }` | Do not call this endpoint |
| Frontend immediately receives a credited balance | Call `POST /api/payments/initialize` with `{ "amount": 1500 }` |
| Mock reference is returned by the API | Redirect the browser to `data.checkoutUrl` |
| No provider callback is required | Kora calls the backend `/api/payments/webhook` after checkout |
| Read the returned `data.newBalance` | Poll `/api/payments/status/:reference`, then refresh `/api/wallets/details` after `SUCCESS` |

The Kora frontend sequence is therefore:

```text
1. Student completes KYC and has an activated wallet.
2. Frontend calls `POST /api/payments/initialize` with an amount from 150 to 10000.
3. Frontend redirects the browser to `data.checkoutUrl`.
4. Student completes payment on Kora Checkout Redirect.
5. Kora returns the browser to `/dashboard?reference=...`.
6. Kora calls the backend webhook; the frontend never calls the webhook.
7. Frontend polls `GET /api/payments/status/:reference`.
8. Frontend refreshes `GET /api/wallets/details` only after `SUCCESS`.
```

Do not put `KORA_PUBLIC_KEY`, `KORA_SECRET_KEY`, `KORA_ENCRYPTION_KEY`, or any
webhook signature in the frontend. The browser only calls the C-Transit API.
The backend selects Kora through `PAYMENT_PROVIDER=KORA` and owns all provider
credentials and callback verification.

The existing `POST /api/payments/create` and `GET /api/payments/fetch` virtual
account endpoints remain compatibility routes. They are not required for the
new Checkout Redirect flow. The frontend should use `POST /api/payments/initialize`
for new wallet funding.

## Driver endpoints

All endpoints below except login and webhook endpoints require:

```http
Authorization: Bearer <driverAccessToken>
```

The JWT role must be `DRIVER`.

### Get driver profile

```http
GET /api/drivers/me
```

The response contains the driver profile in `driver` and `data`, and also
includes the profile fields at the top level for compatibility. New frontend
code should read `driver` first and use `data` only as a compatibility fallback.

### Get driver dashboard

```http
GET /api/drivers/dashboard
```

The dashboard fields are returned at the top level and under `data`. Prefer
`data` in new code.

### List driver rides

```http
GET /api/drivers/rides?page=1&limit=20
```

Query fields:

- `page`: optional page number, default `1`.
- `limit`: optional page size, default `20`.

Response shape:

```json
{
  "success": true,
  "data": [],
  "rides": [],
  "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
}
```

### Request withdrawal

```http
POST /api/drivers/withdraw
```

Body:

```json
{
  "amount": 5000,
  "bankName": "Example Bank",
  "accountNumber": "0123456789",
  "accountName": "Ada Lovelace",
  "remarks": "Weekly withdrawal"
}
```

`bankName`, `accountNumber`, `accountName`, and `remarks` are optional in the request shape, but bank name and account number are required by the service when processing a withdrawal.

### List driver withdrawals

```http
GET /api/drivers/withdrawals?page=1&limit=20
```

Query fields: optional `page` and `limit`.

Response includes both `withdrawals` and `data` for compatibility, plus a
`pagination` object. Prefer `withdrawals` for the list and `pagination` for
navigation.

### Link driver card

```http
POST /api/drivers/card/link
```

Body:

```json
{
  "otp": "123456",
  "cardUid": "04AABBCCDD",
  "driverId": "DRIVER/001"
}
```

`otp` is required. `cardUid` and `driverId` are optional; a supplied `driverId` must belong to the authenticated driver.

### Get driver notifications

```http
GET /api/drivers/notifications
```

### Mark driver notification read

```http
PATCH /api/drivers/notifications/:id/read
PATCH /api/drivers/notifications/:id/mark-read
```

Path field: `id` is the notification ID.

### Mark all driver notifications read

```http
PATCH /api/drivers/notifications/mark-all-read
```

### Payment payout webhooks

```http
POST /api/drivers/payout-webhook
POST /api/drivers/webhook
```

These are provider callbacks, not driver-authenticated requests. They require the appropriate provider signature header and JSON provider payload.

## Agent endpoints

All operation endpoints require:

```http
Authorization: Bearer <agentAccessToken>
```

The JWT role must be `AGENT`, and the agent must be `ACTIVE`. Suspended or deactivated agents are rejected.

The `/api/agents/...` paths below also work under `/api/auth/agent/...`.

### Get pending KYC queue

```http
GET /api/agents/kyc/pending
```

### Approve student KYC

```http
POST /api/agents/kyc/:userId/approve
```

Path field: `userId` is the student's user ID.

### Reject student KYC

```http
POST /api/agents/kyc/:userId/reject
```

Body:

```json
{ "reason": "The ID image is not clear enough" }
```

### List drivers

```http
GET /api/agents/drivers
```

### Register driver

```http
POST /api/agents/drivers/register
```

Body:

```json
{
  "firstname": "Grace",
  "lastname": "Hopper",
  "matricNumber": "DRIVER/001"
}
```

### List terminals

```http
GET /api/agents/terminals
```

Terminal secret keys are not returned.

### Link student card

```http
POST /api/agents/card/link
```

Body:

```json
{
  "otp": "123456",
  "studentId": "student-user-id"
}
```

### List students

```http
GET /api/agents/users?page=1&limit=20&isVerified=true
```

Query fields:

- `page`: optional, minimum `1`, default `1`.
- `limit`: optional, clamped to `1..100`, default `20`.
- `isVerified`: optional literal `true` or `false`.

### Get student transactions

```http
GET /api/agents/users/:matricNumber/transactions?page=1&limit=20
```

Path field: `matricNumber`.

Query fields: optional `page` and `limit`, with the same defaults and limits as the student list.

## Admin endpoints

JWT-protected admin operations require:

```http
Authorization: Bearer <adminAccessToken>
```

The JWT role must be `ADMIN`.

### Create agent

```http
POST /api/admin/agents
```

Body:

```json
{
  "firstname": "Ada",
  "lastname": "Lovelace",
  "email": "ada@example.com",
  "phone": "08000000000",
  "password": "TemporaryPass1"
}
```

### List agents

```http
GET /api/admin/agents?page=1&limit=20&status=ACTIVE
```

Query fields:

- `page`: optional, default `1`.
- `limit`: optional, clamped to `1..100`, default `20`.
- `status`: optional `ACTIVE`, `SUSPENDED`, or `DEACTIVATED`.

Response shape:

```json
{
  "success": true,
  "agents": [],
  "total": 0,
  "page": 1,
  "totalPages": 0
}
```

### Get agent

```http
GET /api/admin/agents/:id
```

Path field: `id` is the agent ID.

### Update agent status

```http
PATCH /api/admin/agents/:id/status
```

Body:

```json
{ "status": "SUSPENDED" }
```

Allowed statuses: `ACTIVE`, `SUSPENDED`, `DEACTIVATED`.

### Admin overview

```http
GET /api/admin/overview
```

### Admin income statistics

```http
GET /api/admin/income?from=2026-09-01&to=2026-09-21&terminalId=T-001&driverUid=DRIVER/001
```

All query fields are optional:

- `from`: date string.
- `to`: date string.
- `terminalId`.
- `driverUid`.

### List terminals

```http
GET /api/admin/terminals
```

### List disputes

```http
GET /api/admin/disputes?page=1&limit=20&status=OPEN
```

Query fields:

- `page`: optional, default `1`.
- `limit`: optional, clamped to `1..100`, default `20`.
- `status`: optional `OPEN`, `UNDER_REVIEW`, `RESOLVED`, or `REJECTED`.

The response is wrapped as `{ "success": true, "disputes": [], ...pagination }`.
Use the returned pagination fields rather than inventing a cursor for this
endpoint.

### Get dispute

```http
GET /api/admin/disputes/:id
```

Path field: `id` is the dispute ID.

### Update dispute status

```http
PATCH /api/admin/disputes/:id/status
```

Body:

```json
{ "status": "RESOLVED", "resolution": "Fare corrected after review." }
```

A resolution is required when closing a dispute.

### Send student notification

```http
POST /api/admin/notifications
```

Body:

```json
{
  "studentMatric": "CU/001",
  "title": "Account update",
  "body": "Your account has been reviewed."
}
```

### Sync whitelist

```http
POST /api/admin/sync/whitelist
```

No request body. The server builds whitelist chunks from card mappings and sends them to the terminal fleet.

## Secret-gated admin system endpoints

These routes require both an `ADMIN` JWT and a backend-only admin secret. They
are mounted at both `/admin/...` and `/api/admin/...`. The shared secret must
never be placed in frontend code, browser storage, or a public frontend
environment variable. In production, the server may accept `x-backend-secret`
according to its environment configuration.

### Approve KYC

```http
POST /api/admin/kyc/approve
```

Headers: admin JWT, backend-only admin secret, JSON content type.

Body:

```json
{ "userId": "student-user-id" }
```

### Reject KYC

```http
POST /api/admin/kyc/reject
```

Headers: admin JWT, backend-only admin secret, JSON content type.

Body:

```json
{
  "userId": "student-user-id",
  "reason": "The submitted document is not valid."
}
```

### Lock terminal with poison pill

```http
POST /api/admin/poison-pill
```

Headers:

- admin JWT
- backend-only admin secret
- `x-critical-approval-token`
- `x-admin-id`
- `Content-Type: application/json`

Body:

```json
{ "terminalId": "T-001" }
```

The terminal is marked `LOCKED`, an audit event is logged, and `CMD:POISON_PILL` is routed to the terminal.

### Broadcast OTA firmware

```http
POST /api/admin/ota
```

Headers: admin JWT, backend-only admin secret, JSON content type.

Body:

```json
{ "firmwareUrl": "https://firmware.example.com/releases/terminal-v1.2.3.bin" }
```

The URL must use HTTPS, contain no credentials or custom port, and its hostname must be present in the server's `FIRMWARE_ALLOWED_HOSTS` environment variable. Unapproved URLs return `403` before broadcasting.

### Confirm registration/card link

```http
POST /api/admin/confirm-registration
```

Headers: admin JWT, backend-only admin secret, JSON content type.

Body:

```json
{ "otp": "123456", "studentId": "student-user-id" }
```

### Monnify webhook

```http
POST /api/admin/monnify-webhook
```

Headers: admin JWT, backend-only admin secret, JSON content type.

Body:

```json
{ "studentUid": "CU/001", "amount": 1500 }
```

### Register or update terminal

```http
POST /api/admin/terminal/register
```

Headers: admin JWT, backend-only admin secret, JSON content type.

Body:

```json
{
  "terminalId": "T-001",
  "secretKey": "terminal-secret",
  "location": "MAIN"
}
```

`location` is optional.

## Payment callback endpoints

These endpoints are provider callbacks and do not use a user, driver, admin, or agent JWT. They require the provider signature header described at the top of this document.

```http
POST /api/payments/fund
POST /api/payments/webhook
POST /api/payments/payout-webhook
```

The provider payload is normalized by the webhook controller. Charge events and payout/transfer events are handled according to the active payment provider.

### Provider webhook payload contract

Use exactly one provider signature header:

```http
x-korapay-signature: <provider-signature>
```

or:

```http
fincra-signature: <provider-signature>
```

For a charge callback, the event name may be supplied as `event` or
`eventType`, and the provider object may be supplied as `data` or `eventData`.
The normalized data must contain a reference, customer email, and positive
amount. A representative payload is:

```json
{
  "event": "charge.success",
  "data": {
    "reference": "payment-reference",
    "customer": { "email": "ada@example.com" },
    "amount": 1500,
    "status": "success"
  }
}
```

For a payout callback, the normalized data must contain a reference, status or
event, amount, fee, and reason:

```json
{
  "event": "transfer.success",
  "data": {
    "reference": "payout-reference",
    "status": "success",
    "amount": 5000,
    "fee": 50,
    "reason": "Transfer completed"
  }
}
```

These are server-to-server callbacks. Invalid signatures or incomplete data
are rejected. Replaying a valid callback is safe: Redis deduplication and
database idempotency prevent a second wallet credit or settlement.

For Kora Checkout Redirect, configure this public backend URL in Kora:

```text
https://c-transit-pink.vercel.app/api/payments/webhook
```

The frontend must never call this URL. The backend captures the exact raw JSON
body before parsing it and verifies `x-korapay-signature`. A browser redirect
to the dashboard does not confirm payment and must not credit the wallet.

### Legacy Monnify admin callback

`POST /api/admin/monnify-webhook` is not part of the provider-signature flow.
It currently requires an admin JWT plus the backend-only admin secret and
accepts:

```json
{ "studentUid": "CU/001", "amount": 1500 }
```

Its acknowledgement is:

```json
{ "received": true }
```

Do not use this endpoint for Kora callbacks.

## Internal endpoint (not available to frontend)

The source contains `POST /internal/settle` with this server-side payload:

```json
{
  "transaction_id": "transaction-id",
  "terminal_id": "T-001",
  "student_uid": "CU/001",
  "amount": 500
}
```

This router is not mounted by `app.ts`; it is not a public endpoint and must
not be called from a browser.

## Notes

- JSON request bodies are limited by the application to 10 KB.
- `Authorization` uses the JWT returned by the applicable login route.
- Admin system routes require an admin JWT plus a backend-only secret and are distinct from JWT-only admin operations.
- The current codebase contains both canonical routes and compatibility aliases; clients should prefer the `/api/agents/...` and `/api/admin/...` forms.
- Internal settlement routes exist in the source tree but are not mounted by `app.ts`; they are intentionally unavailable to frontend clients.
