import { Router, type Request, type Response } from "express";
import {
  approveKycHandler,
  rejectKycHandler,
  requireAdminSecret,
} from "../controller/admin.controller.js";

const router = Router();

router.use(requireAdminSecret);
router.post("/approve", approveKycHandler);
router.post("/reject", rejectKycHandler);

export default router;
