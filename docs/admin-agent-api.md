# C-Transit Admin and Agent API

Frontend integration reference for the backend API.

## Base URLs and authentication

Replace `API_BASE_URL` with the deployed API origin, for example `https://api.example.com`.

Protected requests use the access token returned by login:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Do not send `x-admin-secret` for any endpoint in this document. The secret-gated system and admin KYC endpoints are intentionally excluded.

### Admin login

```http
POST /api/auth/admin/login
```

Request:

```json
{
  "email": "admin@example.com",
  "password": "admin-password"
}
```

Success `200`:

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<jwt>",
  "message": "Login successful"
}
```

The access token lasts 8 hours. The refresh token lasts 7 days.

Errors:

| Status | Response |
|---|---|
| `400` | `{ "message": "Please provide email and password" }` |
| `401` | `{ "message": "Invalid email or password" }` |
| `500` | `{ "message": "Server error" }` |

### Agent login

Primary route:

```http
POST /api/agents/login
```

The same login is also available at `POST /api/auth/agent/login`. All agent operation routes in this document are likewise available under `/api/auth/agent/...`; use `/api/agents/...` as the primary prefix for consistency.

Request:

```json
{
  "email": "agent@example.com",
  "password": "agent-password"
}
```

Success `200`:

```json
{
  "success": true,
  "token": "<jwt>",
  "refreshToken": "<jwt>",
  "agent": {
    "id": "uuid",
    "firstname": "Ada",
    "lastname": "Lovelace",
    "email": "agent@example.com",
    "phone": "08000000000",
    "status": "ACTIVE"
  }
}
```

Use the returned `token` as the Bearer access token. Agent access tokens last 8 hours when issued by agent login. The shared refresh endpoint may issue a 1-hour agent access token.

Errors:

| Status | Response |
|---|---|
| `400` | `{ "error": "Email and password are required" }` |
| `401` | `{ "error": "Invalid email or password" }` |
| `403` | `{ "error": "Agent account is temporarily suspended" }` or `{ "error": "Agent account has been deactivated" }` |
| `500` | `{ "error": "Login failed" }` |

### Refresh and logout

Refresh is available to both admins and agents without an access token:

```http
POST /api/auth/refresh
Content-Type: application/json

{ "refreshToken": "<refresh-jwt>" }
```

Success `200`:

```json
{ "accessToken": "<new-jwt>" }
```

Invalid or expired refresh tokens return `401` with `{ "message": "Invalid or expired refresh token" }`.

Logout is also available without an access token:

```http
POST /api/auth/logout
Content-Type: application/json

{ "refreshToken": "<refresh-jwt>" }
```

Success `200`:

```json
{ "success": true, "message": "Logged out successfully" }
```

## Admin API

All routes below require a valid JWT whose payload has `role: "ADMIN"`. The backend accepts both `/admin` and `/api/admin` prefixes, so the primary examples use `/api/admin`.

### Agent management

#### Create an agent

```http
POST /api/admin/agents
```

```json
{
  "firstname": "Ada",
  "lastname": "Lovelace",
  "email": "ada@example.com",
  "phone": "08000000000",
  "password": "temporary-password"
}
```

Success `201`:

```json
{
  "success": true,
  "agent": {
    "id": "uuid",
    "firstname": "Ada",
    "lastname": "Lovelace",
    "email": "ada@example.com",
    "phone": "08000000000",
    "status": "ACTIVE",
    "createdAt": "2026-08-23T12:00:00.000Z",
    "createdBy": "admin-user-uuid"
  }
}
```

Required fields: `firstname`, `lastname`, `email`, `phone`, `password`.

Errors: `400` missing fields, `409` `{ "error": "An agent with this email already exists" }`, or `500`.

#### List agents

```http
GET /api/admin/agents?page=1&limit=20&status=ACTIVE
```

All query parameters are optional. `status` is one of `ACTIVE`, `SUSPENDED`, `DEACTIVATED`. `page` defaults to `1`; `limit` defaults to `20` and is capped at `100`.

Success `200`:

```json
{
  "success": true,
  "agents": [
    {
      "id": "uuid",
      "firstname": "Ada",
      "lastname": "Lovelace",
      "email": "ada@example.com",
      "phone": "08000000000",
      "status": "ACTIVE",
      "createdAt": "2026-08-23T12:00:00.000Z",
      "createdBy": "admin-user-uuid"
    }
  ],
  "total": 1,
  "page": 1,
  "totalPages": 1
}
```

Invalid status returns `400`.

#### Get one agent

```http
GET /api/admin/agents/:id
```

Success `200` returns `{ "success": true, "agent": { ... } }`, with the list fields plus `updatedAt` and `resolvedDisputeCount`.

`404`: `{ "error": "Agent not found" }`.

#### Change agent status

```http
PATCH /api/admin/agents/:id/status
```

```json
{ "status": "SUSPENDED" }
```

Allowed statuses: `ACTIVE`, `SUSPENDED`, `DEACTIVATED`.

Success `200` returns `{ "success": true, "agent": { ... } }`.

Possible errors: `400` missing/invalid status, `404` agent not found, `409` if already in that status or if a deactivated agent is changed directly to suspended, and `500`.

### Dashboard and terminals

#### Dashboard overview

```http
GET /api/admin/overview
```

Success `200`:

```json
{
  "success": true,
  "overview": {
    "counts": {
      "students": 120,
      "activeAgents": 4,
      "drivers": 18,
      "openDisputes": 3,
      "underReviewDisputes": 2
    },
    "wallets": { "totalBalance": 150000.5, "totalTopUps": 300000.0 },
    "income": { "allTime": 500000, "today": 12000, "thisWeek": 60000, "thisMonth": 210000 },
    "topTerminals": [{ "terminal_id": "T-001", "revenue": 90000 }],
    "topDrivers": [{ "driver_uid": "DRIVER/001", "revenue": 85000 }]
  }
}
```

Amounts are JSON numbers. Dashboard data may be cached for approximately 30 seconds.

#### Income report

```http
GET /api/admin/income?from=2026-08-01T00:00:00.000Z&to=2026-08-23T23:59:59.999Z&terminalId=T-001&driverUid=DRIVER%2F001
```

Optional filters: `from`, `to` (date strings), `terminalId`, `driverUid`. Only `RIDE` transactions are included.

Success `200`:

```json
{
  "success": true,
  "stats": {
    "filters": { "from": "2026-08-01T00:00:00.000Z", "to": "2026-08-23T23:59:59.999Z", "terminalId": "T-001", "driverUid": "DRIVER/001" },
    "total": { "revenue": 12000, "transactions": 84 },
    "byTerminal": [{ "terminal_id": "T-001", "revenue": 12000, "transactions": 84 }],
    "byDriver": [{ "driver_uid": "DRIVER/001", "revenue": 12000, "transactions": 84 }]
  }
}
```

When `terminalId` is supplied, `byTerminal` is an empty array. When `driverUid` is supplied, `byDriver` is an empty array. Invalid dates return `400`.

#### List terminals

```http
GET /api/admin/terminals
```

Success `200`:

```json
{
  "success": true,
  "terminals": [
    { "terminal_id": "T-001", "status": "ONLINE", "active_driver_uid": "DRIVER/001" }
  ]
}
```

`secret_key` is never returned.

### Disputes

#### List disputes

```http
GET /api/admin/disputes?page=1&limit=20&status=OPEN
```

Optional `status`: `OPEN`, `UNDER_REVIEW`, `RESOLVED`, `REJECTED`. Pagination defaults and caps match agent listing.

Success `200`:

```json
{
  "success": true,
  "disputes": [
    {
      "id": "uuid",
      "description": "Incorrect fare",
      "status": "OPEN",
      "resolution": null,
      "resolvedAt": null,
      "createdAt": "2026-08-23T12:00:00.000Z",
      "updatedAt": "2026-08-23T12:00:00.000Z",
      "student_uid": "STU/001",
      "transaction_id": "txn-001",
      "resolvedByAdmin": null,
      "resolvedByAgent": null
    }
  ],
  "total": 1,
  "page": 1,
  "totalPages": 1
}
```

#### Get one dispute

```http
GET /api/admin/disputes/:id
```

Success `200` returns `{ "success": true, "dispute": { ... } }`. The dispute includes `transaction` (`transaction_id`, `type`, `amount`, `terminal_id`, `driver_uid`, `synced_at`) and `user` (`firstname`, `lastname`, `email`).

`404`: `{ "error": "Dispute not found" }`.

#### Update dispute status

```http
PATCH /api/admin/disputes/:id/status
```

```json
{ "status": "RESOLVED", "resolution": "Fare corrected after transaction review" }
```

`status` must be `OPEN`, `UNDER_REVIEW`, `RESOLVED`, or `REJECTED`. A resolution is required when setting `RESOLVED` or `REJECTED`. Closed disputes cannot be changed.

Success `200`:

```json
{
  "success": true,
  "dispute": {
    "id": "uuid",
    "status": "RESOLVED",
    "resolution": "Fare corrected after transaction review",
    "resolvedAt": "2026-08-23T12:05:00.000Z",
    "resolvedByAdmin": "admin-user-uuid",
    "updatedAt": "2026-08-23T12:05:00.000Z"
  }
}
```

Errors: `400` invalid input or missing resolution, `404` not found, `409` already closed, and `500`.

### Notifications and whitelist

#### Send a student notification

```http
POST /api/admin/notifications
```

```json
{
  "studentMatric": "STU/001",
  "title": "Service update",
  "body": "Your wallet has been updated."
}
```

Success `201`:

```json
{
  "success": true,
  "notification": {
    "id": "uuid",
    "title": "Service update",
    "body": "Your wallet has been updated.",
    "isRead": false,
    "createdAt": "2026-08-23T12:00:00.000Z"
  }
}
```

Errors: `400` missing fields, `404` `{ "error": "Student not found" }`, or `500`.

#### Sync card whitelist

```http
POST /api/admin/sync/whitelist
```

No request body is required. Success `200`:

```json
{
  "success": true,
  "message": "Whitelist sync queued for fleet. 120 card(s), 3 chunk(s)."
}
```

### Common admin auth errors

Missing `Authorization` returns `401` with `{ "error": "Access token required" }`. Invalid or expired JWT returns `403` with `{ "error": "Invalid or expired token" }`. A valid token without the admin role returns `403` with `{ "error": "Admin access required" }`.

## Agent API

All operation routes below use the primary `/api/agents` prefix and require a valid JWT with `role: "AGENT"`. The agent must also have `status: "ACTIVE"`; suspended or deactivated agents receive `403` before the handler runs.

### KYC review

#### Pending KYC queue

```http
GET /api/agents/kyc/pending
```

Success `200`:

```json
{
  "success": true,
  "queue": [
    {
      "id": "uuid",
      "userId": "student-user-uuid",
      "idCardImageUrl": "https://res.cloudinary.com/...",
      "submittedAt": "2026-08-23T12:00:00.000Z"
    }
  ]
}
```

The queue is oldest submission first.

#### Approve KYC

```http
POST /api/agents/kyc/:userId/approve
```

No body is required. Success `200` returns `{ "success": true, "kyc": { ... } }`. Approval marks the user verified, approves KYC, activates/creates the wallet, and triggers a notification.

#### Reject KYC

```http
POST /api/agents/kyc/:userId/reject
```

```json
{ "reason": "The ID image is not clear enough" }
```

Success `200` returns `{ "success": true, "kyc": { ... } }`. Missing `reason` returns `400`.

Note: the current approve handler maps the service's `USER_NOT_FOUND` error inconsistently, so a missing user may currently return `500` instead of the documented `404`-style not-found response. The frontend should display the server error generically for this case until the backend mapping is corrected.

### Drivers and terminals

#### List drivers

```http
GET /api/agents/drivers
```

Success `200`:

```json
{
  "success": true,
  "drivers": [
    {
      "id": "uuid",
      "firstname": "Grace",
      "lastname": "Hopper",
      "matricNumber": "DRIVER/001",
      "createdAt": "2026-08-23T12:00:00.000Z",
      "activeTerminal": { "terminal_id": "T-001", "status": "ONLINE", "active_driver_uid": "DRIVER/001" }
    }
  ]
}
```

`activeTerminal` is `null` when the driver is not assigned to a terminal.

#### Register a driver

```http
POST /api/agents/drivers/register
```

```json
{
  "firstname": "Grace",
  "lastname": "Hopper",
  "matricNumber": "DRIVER/001"
}
```

Success `201`:

```json
{
  "success": true,
  "driver": {
    "id": "uuid",
    "firstname": "Grace",
    "lastname": "Hopper",
    "matricNumber": "DRIVER/001",
    "createdAt": "2026-08-23T12:00:00.000Z"
  }
}
```

Errors: `400` missing fields, `409` if the driver already exists or the matric number belongs to another user, and `500`.

#### List terminals

```http
GET /api/agents/terminals
```

Response shape is the same as admin terminal listing. `secret_key` is never returned.

### Card linking

```http
POST /api/agents/card/link
```

```json
{
  "otp": "123456",
  "studentId": "student-user-uuid"
}
```

Success `200` when linked:

```json
{
  "success": true,
  "message": "Card successfully linked and activated.",
  "matricNumber": "STU/001",
  "cardUid": "04AABBCCDD"
}
```

The operation activates the wallet, maps the card, consumes the OTP, and queues whitelist updates. Invalid, expired, already-used, or otherwise unsuccessful OTPs return `200` or `400` depending on the service result, with `{ "success": false, "message": "..." }`. Missing `otp` or `studentId` returns `400`.

### Student lookup

#### List students

```http
GET /api/agents/users?page=1&limit=20&isVerified=true
```

Optional `isVerified` accepts the literal strings `true` or `false`; any other value is treated as no filter. `page` defaults to `1`; `limit` defaults to `20` and is capped at `100`.

Success `200`:

```json
{
  "success": true,
  "students": [
    {
      "id": "uuid",
      "firstname": "Student",
      "lastname": "Example",
      "email": "student@example.com",
      "matricNumber": "STU/001",
      "isVerified": true,
      "createdAt": "2026-08-23T12:00:00.000Z",
      "wallet": { "balance": 2500.5, "is_linked": true },
      "kyc": { "status": "APPROVED", "submittedAt": "2026-08-23T12:00:00.000Z" }
    }
  ],
  "total": 1,
  "page": 1,
  "totalPages": 1
}
```

`wallet` and `kyc` may be `null`.

#### Student transaction history

```http
GET /api/agents/users/:matricNumber/transactions?page=1&limit=20
```

Success `200`:

```json
{
  "success": true,
  "student": {
    "id": "uuid",
    "firstname": "Student",
    "lastname": "Example",
    "matricNumber": "STU/001"
  },
  "transactions": [
    {
      "transaction_id": "txn-001",
      "type": "RIDE",
      "amount": 150,
      "terminal_id": "T-001",
      "driver_uid": "DRIVER/001",
      "synced_at": "2026-08-23T12:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "totalPages": 1
}
```

The matric number is normalized to uppercase by the backend. Missing students return `404` with `{ "error": "Student not found" }`.

### Common agent auth errors

Missing `Authorization` returns `401` with `{ "error": "Access token required" }`. Invalid or expired JWT returns `403` with `{ "error": "Invalid or expired token" }`. A non-agent token returns `403` with `{ "error": "Agent access required" }`. Suspended/deactivated agents receive a `403` with the corresponding account-status message.

## Frontend implementation checklist

1. Store the access token and refresh token separately; send only the access token in the `Authorization` header.
2. On `401`/`403` from a protected request, try `/api/auth/refresh` once with the refresh token, replace the access token, and retry the original request once.
3. Treat `total`, `page`, and `totalPages` as server pagination metadata; do not assume a full page means more results exist.
4. Render timestamps as ISO date strings and amounts as numbers.
5. Never expect or display terminal `secret_key` values.
6. Normalize UI status filters to the exact uppercase enum values documented above.
7. Send JSON bodies for all JSON endpoints, including `{}` or no body where the endpoint says no body is required.

## Backend source map

- Route mounting: `app.ts`, `src/routes/admin.routes.ts`, `src/routes/admin.ops.routes.ts`, `src/routes/agent.routes.ts`, `src/routes/agent.ops.routes.ts`
- Admin handlers: `src/controller/admin.controller.ts`
- Agent handlers: `src/controller/agent.controller.ts`
- Authentication: `src/controller/auth.controller.ts`, `src/middleware/auth.middleware.ts`
- Response data services: `src/services/admin.service.ts`, `src/services/agent.service.ts`, `src/services/driver.service.ts`, `src/services/kyc.service.ts`, `src/services/user.service.ts`