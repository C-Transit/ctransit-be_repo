# C-Transit Backend

HTTP API for the C-Transit platform. Terminal communication is handled by a separate service.

## Stack

Node 20+, TypeScript, Express 5, PostgreSQL (Prisma), Redis.

## Run

```bash
npm install
cp .env.example .env   # fill in every variable listed in .env.example
npm run dev            # development
npm run build && npm run migrate && npm start   # production
```

The server will not start if required configuration is missing or its dependencies are unreachable.

## Structure

```
app.ts, server.ts      app composition and process lifecycle
src/config             environment, logger, redis, cloudinary
src/routes             routing
src/controller         HTTP handlers
src/services           business logic
src/payments           payment provider integration
src/middleware         auth, rate limiting, uploads
src/utils              shared helpers
prisma/                schema and migrations
```

## Configuration

All settings come from environment variables. `.env.example` lists the names. Never commit real values.

## Before deploying

- [ ] `npx tsc --noEmit` is clean
- [ ] `npm run migrate` applied
- [ ] All environment variables set
- [ ] Payment provider webhooks configured
- [ ] CORS origins match the production apps
- [ ] Health endpoint responds
- [ ] No secrets in the repository

Internal project. Do not distribute.