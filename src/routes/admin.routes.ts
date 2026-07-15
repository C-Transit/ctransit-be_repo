import { Router } from "express";
import adminRouter, {
  agentManagementRouter,
} from "../controller/admin.controller.js";
import adminKycRouter from "./admin.kyc.routes.js";

const router = Router();

// Secret-based system ops (poison pill, OTA, terminal register, Monnify webhook)
router.use("/", adminRouter);

// KYC admin review routes
router.use("/kyc", adminKycRouter);

// JWT-protected agent CRUD (create, list, detail, status update)
router.use("/", agentManagementRouter);

export default router;
