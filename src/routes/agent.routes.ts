import { Router } from "express";
import {
  authenticateToken,
  requireAgent,
  checkAgentActive,
} from "../middleware/auth.middleware.js";
import agentOpsRouter from "./agent.ops.routes.js";
import { loginAgentHandler } from "../controller/agent.controller.js";

const router = Router();

// Public login route
router.post("/login", loginAgentHandler);

// All agent-authenticated routes share this chain:
// 1. authenticateToken  — validates JWT, attaches req.user
// 2. requireAgent       — enforces role === "AGENT"
// 3. checkAgentActive   — Redis-first check of agent.status
//    (SUSPENDED / DEACTIVATED agents are rejected here)
router.use(authenticateToken, requireAgent, checkAgentActive);

// Mount all agent operation handlers
router.use("/", agentOpsRouter);

export default router;
