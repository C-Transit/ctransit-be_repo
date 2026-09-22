import crypto from "crypto";
import {
  IPaymentGateway,
  PayoutParams,
  PayoutResponse,
  PayoutStatusQuery,
  VirtualAccountResponse,
} from "./payment.interface.js";
import logger from "../config/logger.js";

export class KoraProvider implements IPaymentGateway {
  private secretKey: string;
  private baseUrl: string;

  constructor(secretKey: string, baseUrl?: string) {
    this.secretKey = secretKey;
    this.baseUrl = baseUrl || process.env.KORA_BASE_URL || "https://api.korapay.com/merchant";
  }

  async createVirtualAccount(
    _name: string,
    _email: string,
    reference: string
  ): Promise<VirtualAccountResponse> {
    return {
      accountNumber: "KORA_PENDING_LIVE",
      bankName: "Kora Provider Bank",
      reference,
    };
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!signature || !this.secretKey) {
      return false;
    }

    try {
      const expectedSignature = crypto
        .createHmac("sha512", this.secretKey)
        .update(rawBody)
        .digest("hex");

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  async initiatePayout(params: PayoutParams): Promise<PayoutResponse> {
    const endpoint = `${this.baseUrl}/api/v1/transactions/disburse`;

    const requestPayload = {
      reference: params.reference,
      destination: {
        type: "bank_account",
        amount: params.amount,
        currency: params.destination.currency || "NGN",
        narration:
          params.destination.narration ||
          `C-Transit Driver Payout ${params.reference}`,
        bank_account: {
          bank: params.destination.bank_account.bank,
          account: params.destination.bank_account.account,
        },
      },
      customer: {
        name: params.customer.name,
        email: params.customer.email,
      },
    };

    logger.info(
      { reference: params.reference, amount: params.amount },
      "kora.payout_initiating"
    );

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(10000),
      });

      // Unexpected 5xx server error from Kora -> verify first before failing!
      if (response.status >= 500) {
        logger.warn(
          { reference: params.reference, statusCode: response.status },
          "kora.payout_server_error — verifying payout status before deciding"
        );
        return await this.verifyAndResolvePayout(params.reference);
      }

      const responseBody = await response.json().catch(() => null);

      if (!response.ok || !responseBody || responseBody.status === false) {
        // 4xx or business error from Kora
        const failureMsg =
          responseBody?.message || `Kora payout rejected (HTTP ${response.status})`;
        logger.warn(
          { reference: params.reference, error: failureMsg },
          "kora.payout_rejected"
        );
        return {
          success: false,
          status: "failed",
          reference: params.reference,
          message: failureMsg,
          rawResponse: responseBody,
        };
      }

      const data = responseBody.data || {};
      const rawStatus = (data.status || "processing").toLowerCase();
      const status: PayoutResponse["status"] =
        rawStatus === "success"
          ? "success"
          : rawStatus === "failed"
            ? "failed"
            : "processing";

      const koraFee =
        data.fee !== undefined ? parseFloat(data.fee.toString()) : undefined;

      logger.info(
        {
          reference: params.reference,
          koraReference: data.reference,
          status,
          koraFee,
        },
        "kora.payout_initiated_response"
      );

      return {
        success: status !== "failed",
        status,
        reference: params.reference,
        koraReference: data.reference || data.transaction_reference,
        fee: koraFee,
        message: responseBody.message,
        rawResponse: responseBody,
      };
    } catch (err) {
      // Network timeout or connection drop -> verify first!
      const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" ||
          err.name === "AbortError" ||
          err.message.includes("timeout"));

      logger.warn(
        { reference: params.reference, isTimeout, err: err instanceof Error ? err.message : String(err) },
        "kora.payout_request_error — verifying payout status"
      );

      return await this.verifyAndResolvePayout(params.reference);
    }
  }

  async verifyPayout(reference: string): Promise<PayoutStatusQuery> {
    const endpoint = `${this.baseUrl}/api/v1/transactions/${encodeURIComponent(reference)}`;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 404) {
        return {
          status: "not_found",
          reference,
          message: "Transaction not found on Kora",
        };
      }

      if (!response.ok) {
        return {
          status: "unknown",
          reference,
          message: `Kora status check returned HTTP ${response.status}`,
        };
      }

      const body = await response.json().catch(() => null);
      if (!body || body.status === false || !body.data) {
        return {
          status: "unknown",
          reference,
          message: body?.message || "Invalid response from Kora status check",
        };
      }

      const data = body.data;
      const rawStatus = (data.status || "").toLowerCase();
      let mappedStatus: PayoutStatusQuery["status"] = "processing";
      if (rawStatus === "success" || rawStatus === "successful") {
        mappedStatus = "success";
      } else if (rawStatus === "failed" || rawStatus === "rejected") {
        mappedStatus = "failed";
      } else if (rawStatus === "processing" || rawStatus === "pending") {
        mappedStatus = "processing";
      }

      const fee =
        data.fee !== undefined ? parseFloat(data.fee.toString()) : undefined;
      const amount =
        data.amount !== undefined ? parseFloat(data.amount.toString()) : undefined;

      return {
        status: mappedStatus,
        reference,
        koraReference: data.reference || data.transaction_reference,
        amount,
        fee,
        message: body.message,
      };
    } catch (err) {
      logger.warn(
        { reference, err: err instanceof Error ? err.message : String(err) },
        "kora.verify_payout_failed"
      );
      return {
        status: "unknown",
        reference,
        message: err instanceof Error ? err.message : "Verification request failed",
      };
    }
  }

  private async verifyAndResolvePayout(reference: string): Promise<PayoutResponse> {
    const query = await this.verifyPayout(reference);

    if (query.status === "success") {
      return {
        success: true,
        status: "success",
        reference,
        koraReference: query.koraReference,
        fee: query.fee,
        message: "Payout verified as SUCCESS following initial timeout",
      };
    }

    if (query.status === "failed") {
      return {
        success: false,
        status: "failed",
        reference,
        koraReference: query.koraReference,
        fee: query.fee,
        message: query.message || "Payout verified as FAILED following initial timeout",
      };
    }

    if (query.status === "processing" || query.status === "pending") {
      return {
        success: true,
        status: "processing",
        reference,
        koraReference: query.koraReference,
        fee: query.fee,
        message: "Payout verified as PROCESSING following initial timeout",
      };
    }

    return {
      success: true,
      status: "ambiguous_timeout",
      reference,
      message:
        "Payout request timed out and status is currently ambiguous; held in PROCESSING pending webhook/query reconciliation.",
    };
  }
}
