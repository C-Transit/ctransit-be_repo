import { Router } from "express";
import {
  requireStudentAuth,
  linkWallet,
  getWalletDetails,
} from "../controller/wallets.controller.js";

const router = Router();

router.post("/link", requireStudentAuth, linkWallet);
router.get("/details", requireStudentAuth, getWalletDetails);

export default router;
