# C-Transit Backend

Backend services powering the C-Transit transportation platform.

## Overview

C-Transit provides a secure transportation and digital-wallet
platform connecting students, transportation operators,
administrators, and transit terminals.

## Features

- Authentication and account management
- Student profiles and verification
- Wallet management
- Payments and top-ups
- Transportation transactions
- KYC workflows
- Agent management
- Dispute management
- Notifications
- Terminal operations
- Real-time transportation infrastructure

## Architecture

Client Applications
        │
        ▼
   C-Transit API
        │
   ┌────┼────┐
   ▼    ▼    ▼
Database Cache Integrations
        │
        ▼
 Terminal Services
        │
        ▼
   Transit Devices

## Technology

- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma
- Redis
- REST APIs
- MQTT-based device communication

## Development

npm install
npm run dev

## Production

npm run build
npm start

## Environment

Create a `.env` file using `.env.example`.

Do not commit environment files or credentials.

## Project structure

src/
├── controller/
├── middleware/
├── routes/
├── services/
├── payments/
└── utils/

prisma/
└── schema.prisma

## Documentation

Internal architecture, infrastructure, operational procedures,
and security documentation are maintained separately. HTTP requests
   ↓
N terminal operations
```

### Database

Use the existing Prisma indexes before introducing new caching.

Important indexed patterns include:

```text
User(role, isVerified)
Wallet(is_linked)
Transaction(student_uid, synced_at)
Transaction(terminal_id, synced_at)
Transaction(type)
Transaction(driver_uid, synced_at)
Terminal(status)
Kyc(status)
Kyc(status, submittedAt)
Blacklist(blacklistedAt)
CardMapping(linkedAt)
Agent(status)
Agent(createdBy, status)
```

### Financial correctness

Do not trade correctness for throughput.

Wallet/transaction changes must preserve:

- uniqueness;
- atomicity;
- balance consistency;
- idempotency.

Do not replace financial database operations with eventually-consistent cache state.

---

# Development guidelines

Before changing a feature, trace:

```text
route
→ middleware
→ controller
→ service
→ database/external integration
```

Also identify whether the MQTT service owns part of the workflow.

This is especially important for:

```text
terminal commands
whitelist/blacklist synchronization
transactions
payments
wallet changes
```

### Keep responsibilities separated

```text
routes/
    routing + middleware composition

controller/
    HTTP request/response handling

services/
    business logic

config/
    infrastructure configuration

middleware/
    cross-cutting request behavior

payments/
    payment provider implementations

utils/
    narrowly scoped shared utilities
```

### MQTT changes

Terminal communication changes should be coordinated with the separate MQTT repository.

Do not independently change:

- command formats;
- delivery guarantees;
- terminal synchronization semantics;
- offline behavior

from this repository without validating the MQTT service.

---

# Testing checklist

## Authentication

- [ ] Student registration
- [ ] OTP verification
- [ ] Login
- [ ] Refresh token
- [ ] Logout/revocation
- [ ] Password reset

## KYC

- [ ] ID-card upload
- [ ] KYC submission
- [ ] KYC status
- [ ] Approval
- [ ] Rejection
- [ ] Wallet activation

## Wallet/payment

- [ ] Wallet details
- [ ] Wallet linking
- [ ] Virtual account
- [ ] Top-up
- [ ] Payment webhook

## Transactions

- [ ] Transaction history
- [ ] Ownership checks
- [ ] Transaction uniqueness

## Agents

- [ ] Agent login
- [ ] Suspension/deactivation
- [ ] KYC review
- [ ] Driver registration
- [ ] Terminal listing
- [ ] Card linking
- [ ] Student lookup

## Admin

- [ ] Admin authentication
- [ ] Overview
- [ ] Income
- [ ] Terminal operations
- [ ] Agent management
- [ ] Disputes
- [ ] Notifications
- [ ] Whitelist synchronization
- [ ] OTA
- [ ] Poison pill
- [ ] Terminal registration

## MQTT

- [ ] Internal authentication
- [ ] Terminal command routing
- [ ] Fleet command routing
- [ ] Offline terminal behavior
- [ ] Registration synchronization

---

# Useful commands

```bash
npm install
npm run dev
npm run build
npm run lint

npx prisma generate
npx prisma migrate dev
npx prisma migrate deploy
npx prisma studio

npm start
```

---

# Environment reference

| Variable | Purpose |
|---|---|
| `PORT` | HTTP server port |
| `NODE_ENV` | Runtime environment |
| `DATABASE_URL` | Direct PostgreSQL connection / migrations |
| `DATABASE_URL_POOLED` | Pooled PostgreSQL runtime connection |
| `REDIS_URL` | Redis connection |
| `ADMIN_API_SECRET` | Privileged admin/system operations |
| `JWT_SECRET` | Access-token signing secret |
| `JWT_REFRESH_SECRET` | Refresh-token signing secret |
| `OTP_SECRET` | OTP secret |
| `ALLOWED_EMAIL_DOMAIN` | Student email-domain restriction |
| `MAIL_USER` | SMTP account |
| `MAIL_PASSWORD` | SMTP password |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary secret |
| `PAYMENT_PROVIDER` | `MOCK`, `KORA`, or `FINCRA` |
| `PAYMENT_SECRET_KEY` | Payment provider credential |
| `MQTT_INTERNAL_URL` | Internal MQTT-service HTTP URL |
| `MQTT_INTERNAL_SECRET` | Shared MQTT-service secret |
| `BASE_FARE` | Base fare configuration |

---

# Production deployment checklist

- [ ] `NODE_ENV=production`
- [ ] Strong JWT secrets configured
- [ ] Strong admin secret configured
- [ ] Strong MQTT internal secret configured
- [ ] Production Neon URLs configured
- [ ] Redis URL configured
- [ ] Cloudinary credentials configured
- [ ] SMTP credentials configured
- [ ] Correct payment provider selected
- [ ] Payment secret configured
- [ ] Prisma migrations deployed
- [ ] `/test-bridge` unavailable
- [ ] CORS origins match production clients
- [ ] MQTT service reachable from the API
- [ ] MQTT internal secret matches on both services
- [ ] Health endpoint responds
- [ ] Production logs are available
- [ ] No secrets are committed

---

# Related service

The terminal communication layer is maintained separately as the **C-Transit MQTT service**.

```text
┌─────────────────────────────┐
│      C-Transit Backend      │
│                             │
│ HTTP / Auth / DB / Business │
│ Logic / Admin / Payments    │
└──────────────┬──────────────┘
               │
        Internal HTTP
               │
               ▼
┌─────────────────────────────┐
│     C-Transit MQTT Service  │
│                             │
│ MQTT / Terminals / Queues   │
│ Sync / Device ingestion     │
└──────────────┬──────────────┘
               │
               ▼
             HiveMQ
               │
               ▼
           Terminals
```

Changes crossing this boundary should be coordinated across both repositories.

---

# Source of truth

When this README conflicts with implementation, the source code is authoritative:

1. `prisma/schema.prisma` — data model
2. `src/routes/` — API routing
3. `src/middleware/` — authorization and request controls
4. `src/controller/` — HTTP behavior
5. `src/services/` — business behavior
6. `src/payments/` — payment contracts/providers
7. `src/utils/bridge.ts` — MQTT service boundary
8. `app.ts` — application composition
9. `server.ts` — runtime/bootstrap behavior

Keep this README updated whenever a major architectural boundary, external dependency, deployment requirement, or feature changes.

---

## License

Internal C-Transit project. Distribution and licensing are governed by the project owners.
