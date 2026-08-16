"use strict";

import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import cors from "cors";
import "dotenv/config";
import logger from "./src/config/logger.js";
import connectDB from "./src/config/db.js";
import { enqueueBroadcast, enqueueRoute } from "./src/utils/bridge.js";

import healthRouter from "./src/routes/health.routes.js";
import adminRouter from "./src/routes/admin.routes.js";
import authRoutes from "./src/routes/auth.routes.js";
import userRoutes from "./src/routes/user.routes.js";
import kycRoutes from "./src/routes/kyc.routes.js";
import transactionRoutes from "./src/routes/transaction.routes.js";
import agentRoutes from "./src/routes/agent.routes.js";
import disputeRoutes from "./src/routes/dispute.routes.js";
import notificationRoutes from "./src/routes/notification.routes.js";
import walletsRouter from "./src/routes/wallet.routes.js";
import paymentRoutes from "./src/routes/payment.routes.js";
import { authenticateToken } from "./src/middleware/auth.middleware.js";
import {
  globalLimiter,
  loginLimiter,
  adminLoginLimiter,
  registerLimiter,
  otpLimiter,
  kycSubmitLimiter,
  kycStatusLimiter,
  transactionLimiter,
  walletLimiter,
  disputeLimiter,
  notificationLimiter,
} from "./src/middleware/rate-limit.middleware.js";

const app = express();

app.set("trust proxy", 1);

app.use(morgan("dev"));
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(
  cors({
    origin: [
      "https://www.ctransit.me",
      "https://www.admin.ctransit.me",
      "https://www.agent.ctransit.me",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
      "https://ctransit-fe-repo.vercel.app",
      "https://c-transit-pink.vercel.app",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

connectDB();

// ── Request logger ──────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info(
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        ip: req.ip,
      },
      "http.request"
    );
  });
  next();
});

// ── Global rate limit ceiling ─────────────────────────────────────────────
// Applies to every route. Specific limiters below override this for
// sensitive endpoints — express matches middleware in registration order.
app.use(globalLimiter);

app.get("/", (req: Request, res: Response) => {
  res.send("C-transit server is running");
});

app.use("/health", healthRouter);
app.use(["/admin", "/api/admin"], adminRouter);

// ── Auth ────────────────
// Specific limiters registered before the router so they fire first.
// express-rate-limit matches on path prefix at the app level.
app.use("/api/auth/register", registerLimiter);
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/admin/login", adminLoginLimiter);
app.use("/api/auth/verify-otp", otpLimiter);
app.use("/api/auth/resend-otp", otpLimiter);
app.use("/api/auth", authRoutes);

app.use("/api/users", userRoutes);

// ── KYC 
app.use("/api/kyc/submit", kycSubmitLimiter);
app.use("/api/kyc/status", kycStatusLimiter);
app.use("/api/kyc", kycRoutes);

// ── Wallets 
app.use("/api/wallets", walletLimiter, authenticateToken, walletsRouter);

app.use("/api/payments", paymentRoutes);

// ── Transactions 
app.use(
  "/api/transactions",
  transactionLimiter,
  authenticateToken,
  transactionRoutes
);

// ── Agents 
// authenticateToken not applied here — agent.routes.ts owns the full
// middleware chain: authenticateToken → requireAgent → checkAgentActive
app.use("/api/agents", agentRoutes);

// ── Disputes 
app.use("/api/disputes", disputeLimiter, disputeRoutes);

// ── Notifications 
app.use("/api/notifications", notificationLimiter, notificationRoutes);

// e.g. in server.ts before the 404 handler
app.post('/test-bridge', async (req, res) => {
  try {
    const { command, terminalId } = req.body;
    if (terminalId) {
      await enqueueRoute(terminalId, command);
    } else {
      await enqueueBroadcast(command);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── 404
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler 
// Must have exactly 4 params for Express to treat it as an error handler
// rather than regular middleware — next is required even if unused.
app.use((err: Error, req: Request, res: Response) => {
  logger.error({ err: err.message, path: req.path }, "http.unhandled_error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
