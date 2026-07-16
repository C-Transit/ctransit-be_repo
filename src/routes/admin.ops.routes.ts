import { Router } from "express";
import {
  createAgentHandler,
  listAgentsHandler,
  getAgentByIdHandler,
  updateAgentStatusHandler,
  getAdminOverviewHandler,
  getIncomeStatsHandler,
  listTerminalsHandler as listAdminTerminalsHandler,
  listDisputesHandler,
  getDisputeByIdHandler,
  updateDisputeStatusHandler,
  sendNotificationHandler,
  syncWhitelistHandler,
} from "../controller/admin.controller.js";

const router = Router();

router.post("/agents", createAgentHandler);
router.get("/agents", listAgentsHandler);
router.get("/agents/:id", getAgentByIdHandler);
router.patch("/agents/:id/status", updateAgentStatusHandler);
router.get("/overview", getAdminOverviewHandler);
router.get("/income", getIncomeStatsHandler);
router.get("/terminals", listAdminTerminalsHandler);
router.get("/disputes", listDisputesHandler);
router.get("/disputes/:id", getDisputeByIdHandler);
router.patch("/disputes/:id/status", updateDisputeStatusHandler);
router.post("/notifications", sendNotificationHandler);
router.post("/sync/whitelist", syncWhitelistHandler);

export default router;
