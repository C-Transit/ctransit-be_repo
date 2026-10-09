// app.ts
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import env from "./src/config/env.js";
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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
      rawBody?: string;
    }
  }
}

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin:
      env.NODE_ENV === "production"
        ? [
            "https://www.ctransit.me",
            "https://admin.ctransit.me",
            "https://agent.ctransit.me",
            "https://driver.ctransit.me",
          ]
        : [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://localhost:3003",
            "https://c-transit-pink.vercel.app",
            "https://ctransit-driver.vercel.app",
          ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);

app.use((req, res, next) => {
  req.id = (req.headers["x-request-id"] as string) || randomUUID();
  res.setHeader("x-request-id", req.id);

  res.set({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-dns-prefetch-control": "off",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
  });

  if (env.NODE_ENV === "production") {
    res.setHeader(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains"
    );
  }

  next();
});

app.use(
  express.json({
    limit: "10kb",
    verify: (req, _res, buffer) => {
      (req as express.Request).rawBody = buffer.toString("utf8");
    },
  })
);
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const logData = {
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip,
    };

    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    const eventName =
      level === "info"
        ? "http.request"
        : `http.${level === "error" ? "server_error" : "client_error"}`;
    logger[level](logData, eventName);
  });

  next();
});

app.use(globalLimiter);

app.get("/", (_req, res) => {
  res.send("C-transit server is running");
});

app.use(["/health", "/api/health"], healthRouter);
app.use(["/admin", "/api/admin"], adminRouter);

app.use("/api/auth/register", registerLimiter);
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/admin/login", adminLoginLimiter);
app.use("/api/auth/verify-otp", otpLimiter);
app.use("/api/auth/resend-otp", otpLimiter);
app.use("/api/auth", authRoutes);

app.use("/api/users", userRoutes);

app.use("/api/kyc/submit", kycSubmitLimiter);
app.use("/api/kyc/status", kycStatusLimiter);
app.use("/api/kyc", kycRoutes);

app.use("/api/wallets", walletLimiter, authenticateToken, walletsRouter);
app.use("/api/payments", paymentRoutes);
app.use(
  "/api/transactions",
  transactionLimiter,
  authenticateToken,
  transactionRoutes
);
app.use("/api/agents", agentRoutes);
app.use("/api/disputes", disputeLimiter, disputeRoutes);
app.use("/api/notifications", notificationLimiter, notificationRoutes);
app.use("/api/drivers", driverRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: err.message, path: req.path }, "http.unhandled_error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
