"use strict";

import { randomUUID } from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import cors from "cors";
import "dotenv/config";
import logger from "./src/config/logger.js";

import healthRouter from "./src/routes/health.routes.js";
import adminRouter from "./src/routes/admin.routes.js";
import authRoutes from "./src/routes/auth.routes.js";
import userRoutes from "./src/routes/user.routes.js";
import kycRoutes from "./src/routes/kyc.routes.js";
import transactionRoutes from "./src/routes/transaction.routes.js";
import agentRoutes from "./src/routes/agent.routes.js";
import disputeRoutes from "./src/routes/dispute.routes.js";
import notificationRoutes from "./src/routes/notification.routes.js";
import driverRoutes from "./src/routes/driver.routes.js";
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

type RequestWithId = Request & { id?: string; rawBody?: string };

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: [
      "https://www.ctransit.me",
      "https://admin.ctransit.me",
      "https://agent.ctransit.me",
      "https://driver.ctransit.me",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
      "http://localhost:3003",
      "https://c-transit-pink.vercel.app",
      "https://ctransit-driver.vercel.app",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.use((req: RequestWithId, _res: Response, next: NextFunction) => {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) || randomUUID();
  req.headers["x-request-id"] = requestId;
  req.id = requestId;
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const isHttps =
    req.secure || req.headers["x-forwarded-proto"] === "https";

  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-dns-prefetch-control", "off");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("permissions-policy", "geolocation=(), microphone=(), camera=()");

  if (isHttps && process.env.NODE_ENV === "production") {
    res.setHeader(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains"
    );
  }

  next();
});

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}
app.use(
  express.json({
    limit: "10kb",
    verify: (req, _res, buffer) => {
      (req as RequestWithId).rawBody = buffer.toString("utf8");
    },
  })
);
app.use(express.urlencoded({ extended: false }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId =
    (req.headers["x-request-id"] as string | undefined) || randomUUID();

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const logData = {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip,
    };

    if (res.statusCode >= 500) {
      logger.error(logData, "http.server_error");
    } else if (res.statusCode >= 400) {
      logger.warn(logData, "http.client_error");
    } else {
      logger.info(logData, "http.request");
    }
  });

  res.setHeader("x-request-id", requestId);
  next();
});

// Global rate limiter
app.use(globalLimiter);

app.get("/", (req: Request, res: Response) => {
  res.send("C-transit server is running");
});

app.use(["/health", "/api/health"], healthRouter);
app.use(["/admin", "/api/admin"], adminRouter);

// Authentication & user management
app.use("/api/auth/register", registerLimiter);
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/admin/login", adminLoginLimiter);
app.use("/api/auth/verify-otp", otpLimiter);
app.use("/api/auth/resend-otp", otpLimiter);
app.use("/api/auth", authRoutes);

app.use("/api/users", userRoutes);

// KYC 
app.use("/api/kyc/submit", kycSubmitLimiter);
app.use("/api/kyc/status", kycStatusLimiter);
app.use("/api/kyc", kycRoutes);

// Wallets 
app.use("/api/wallets", walletLimiter, authenticateToken, walletsRouter);

app.use("/api/payments", paymentRoutes);

// Transactions 
app.use(
  "/api/transactions",
  transactionLimiter,
  authenticateToken,
  transactionRoutes
);

// Agents 
app.use("/api/agents", agentRoutes);

// Disputes 
app.use("/api/disputes", disputeLimiter, disputeRoutes);

// Notifications 
app.use("/api/notifications", notificationLimiter, notificationRoutes);

// Drivers
app.use("/api/drivers", driverRoutes);

// 404
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, path: req.path }, "http.unhandled_error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
