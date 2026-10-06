// kyc.controller.ts
import type { Response } from "express";
import { submitKyc, getKycByUserId } from "../services/kyc.service.js";
import logger from "../config/logger.js";
import type { AuthenticatedRequest } from "./auth.controller.js";
import "multer";

export interface KycUploadRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

// ─────────────────────────────────────────────
// POST /api/kyc/submit
// Multipart upload — image only, no text fields.
// Cloudinary upload + DB write in one request.
// ─────────────────────────────────────────────
export const submitKycHandler = async (
  req: KycUploadRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "ID card image is required" });
    }

    const kyc = await submitKyc(userId, req.file.buffer);

    return res.status(201).json({
      message: "KYC submitted successfully. Pending admin review.",
      data: { kycId: kyc.id },
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "kyc.submit_error");
    return res.status(500).json({ message: "Failed to submit KYC" });
  }
};

// ─────────────────────────────────────────────
// GET /api/kyc/status
// Student checks their own KYC status.
// ─────────────────────────────────────────────
export const getKycStatus = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const kyc = await getKycByUserId(userId);

    if (!kyc) {
      return res.status(404).json({ message: "KYC not yet submitted" });
    }

    return res.status(200).json({
      data: kyc.status,
      message: `Your KYC status is ${kyc.status}`,
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: errMessage }, "kyc.status_error");
    return res.status(500).json({ message: "Failed to fetch KYC status" });
  }
};
