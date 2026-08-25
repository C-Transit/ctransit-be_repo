import { Router } from "express";
import {
  approveKycHandler,
  rejectKycHandler,
  requireAdminSecret,
} from "../controller/admin.controller.js";

const router = Router();

router.post("/approve", requireAdminSecret, approveKycHandler);
router.post("/reject", requireAdminSecret, rejectKycHandler);

export default router;
