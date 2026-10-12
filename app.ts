import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import env from "./src/config/env.js";
import logger from "./src/config/logger.js";

import healthRouter from "./src/controller/health.controller.js";
import adminOpsRouter from "./src/routes/admin.ops.routes.js";
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
          "https://ctransit.me",
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

// Provider callbacks: signature-verified, so never throttled by the global limiter.
const WEBHOOK_PATHS = new Set([
  "/api/payments/webhook",
  "/api/payments/payout-webhook",
  "/api/drivers/payout-webhook",
]);

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
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  next();
});

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    const eventName =
      level === "info" ? "http.request" : `http.${level === "error" ? "server_error" : "client_error"}`;

    logger[level](
      {
        requestId: req.id,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        ip: req.ip,
      },
      eventName
    );
  });

  next();
});

app.use((req, res, next) => (WEBHOOK_PATHS.has(req.path) ? next() : globalLimiter(req, res, next)));

app.get("/", (_req, res) => {
  res.send("C-transit server is running");
});

app.use(["/health", "/api/health"], healthRouter);
app.use(["/admin", "/api/admin"], adminOpsRouter);

app.use("/api/auth/register", registerLimiter);
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/admin/login", adminLoginLimiter);
app.use("/api/auth/verify-otp", otpLimiter);
app.use("/api/auth/resend-otp", otpLimiter);
app.use("/api/auth", authRoutes);

app.use("/api/users/forgot-password", otpLimiter);
app.use("/api/users/reset-password", otpLimiter);
app.use("/api/users", userRoutes);

app.use("/api/kyc/submit", kycSubmitLimiter);
app.use("/api/kyc/status", kycStatusLimiter);
app.use("/api/kyc", kycRoutes);

app.use("/api/wallets", walletLimiter, authenticateToken, walletsRouter);
app.use("/api/payments", paymentRoutes);
app.use("/api/transactions", transactionLimiter, authenticateToken, transactionRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/disputes", disputeLimiter, disputeRoutes);
app.use("/api/notifications", notificationLimiter, notificationRoutes);
app.use("/api/drivers", driverRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { type?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Body-parser failures are the client's fault, not a server error.
  if (err.name === "MulterError") return res.status(400).json({ error: err.message });
  if (err.message === "Only JPEG, PNG, and WEBP images are allowed") return res.status(400).json({ error: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });

  logger.error({ err: err.message, path: req.path }, "http.unhandled_error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;