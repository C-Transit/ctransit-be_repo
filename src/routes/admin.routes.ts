import { Router } from "express";
import adminKycRouter from "./admin.kyc.routes.js";
import adminOpsRouter from "./admin.ops.routes.js";
import adminSystemRouter from "./admin.system.routes.js";

const router = Router();

// Secret-based system ops (poison pill, OTA, terminal register, Monnify webhook)
router.use("/", adminSystemRouter);

// KYC admin review routes
router.use("/kyc", adminKycRouter);

// JWT-protected admin operations
router.use("/", adminOpsRouter);

export default router;
