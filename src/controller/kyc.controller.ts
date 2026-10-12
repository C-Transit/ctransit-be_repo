import type { Response } from "express";
import "multer";
import { submitKyc, getKycByUserId } from "../services/kyc.service.js";
import logger from "../config/logger.js";
import type { AuthenticatedRequest } from "./auth.controller.js";

export interface KycUploadRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");

// POST /api/kyc/submit: multipart, ID card image only.
export const submitKycHandler = async (req: KycUploadRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ message: "ID card image is required" });

  try {
    const kyc = await submitKyc(req.user!.userId, req.file.buffer);
    return res.status(201).json({
      message: "KYC submitted successfully. Pending admin review.",
      data: { kycId: kyc.id },
    });
  } catch (error) {
    logger.error({ err: errMsg(error) }, "kyc.submit_error");
    return res.status(500).json({ message: "Failed to submit KYC" });
  }
};

// GET /api/kyc/status: a student checks their own KYC status.
export const getKycStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const kyc = await getKycByUserId(req.user!.userId);
    if (!kyc) return res.status(404).json({ message: "KYC not yet submitted" });

    return res.status(200).json({ data: kyc.status, message: `Your KYC status is ${kyc.status}` });
  } catch (error) {
    logger.error({ err: errMsg(error) }, "kyc.status_error");
    return res.status(500).json({ message: "Failed to fetch KYC status" });
  }
};