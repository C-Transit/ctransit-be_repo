import { Router } from "express";
import {
  getPendingKycHandler,
  approveAgentKycHandler,
  rejectAgentKycHandler,
  listDriversHandler,
  registerDriverHandler,
  listTerminalsHandler,
  linkCardHandler,
  listUsersHandler,
  getStudentTransactionsHandler,
} from "../controller/agent.controller.js";

const router = Router();

router.get("/kyc/pending", getPendingKycHandler);
router.post("/kyc/:userId/approve", approveAgentKycHandler);
router.post("/kyc/:userId/reject", rejectAgentKycHandler);
router.get("/drivers", listDriversHandler);
router.post("/drivers/register", registerDriverHandler);
router.get("/terminals", listTerminalsHandler);
router.post("/card/link", linkCardHandler);
router.get("/users", listUsersHandler);
router.get("/users/:matricNumber/transactions", getStudentTransactionsHandler);

export default router;
