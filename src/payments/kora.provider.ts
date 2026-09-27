import crypto from "crypto";
import {
  IPaymentGateway,
  PayoutParams,
  PayoutResponse,
  PayoutStatusQuery,
  VirtualAccountResponse,
  BankAccountResolution,
  CheckoutInitializationParams,
  CheckoutInitializationResponse,
} from "./payment.interface.js";
import logger from "../config/logger.js";

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4
    ? `${"*".repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`
    : "****";
}

export class KoraProvider implements IPaymentGateway {
  private secretKey: string;
  private baseUrl: string;

  constructor(secretKey: string, baseUrl?: string) {
    this.secretKey = secretKey;
    this.baseUrl =
      baseUrl ||
      process.env.KORA_BASE_URL ||
      "https://api.korapay.com/merchant";
  }

  async initializeCheckout(
    params: CheckoutInitializationParams
  ): Promise<CheckoutInitializationResponse> {
    const endpoint = `${this.baseUrl}/api/v1/charges/initialize`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        reference: params.reference,
        redirect_url: params.redirectUrl,
        notification_url: params.notificationUrl,
        narration: params.narration,
        customer: params.customer,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const body = await response.json().catch(() => null);
    const checkoutUrl = body?.data?.checkout_url;
    if (
      !response.ok ||
      body?.status !== true ||
      typeof checkoutUrl !== "string"
    ) {
      const detail = body?.errors
        ? ` [${body.errors.attribute ?? "unknown_field"}: ${
            body.errors.message ?? "no detail"
          }]`
        : "";
      logger.error(
        { koraResponse: body, statusCode: response.status },
        "kora.checkout_validation_failed"
      );

      // Preserve KORA's actual HTTP status on the thrown error so the
      // upstream error handler can respond with 4xx for client errors
      // (422, 400, 401) instead of a misleading 502.
      const err = new Error(
        (body?.message ||
          `Kora checkout initialization failed (HTTP ${response.status})`) +
          detail
      ) as Error & { statusCode?: number; koraBody?: unknown };
      err.statusCode = response.status;
      err.koraBody = body;
      throw err;
    }

    return {
      reference: body.data.reference || params.reference,
      checkoutUrl,
    };
  }

  async createVirtualAccount(
    name: string,
    email: string,
    reference: string
  ): Promise<VirtualAccountResponse> {
    const endpoint = `${this.baseUrl}/api/v1/virtual-bank-account`;
    const bankCode = process.env.KORA_VIRTUAL_ACCOUNT_BANK_CODE || "000";

    const requestPayload = {
      account_name: name,
      account_reference: reference,
      permanent: true,
      bank_code: bankCode,
      customer: {
        name,
        email,
      },
    };

    logger.info(
      { reference, bankCode, customerEmail: email },
      "kora.virtual_account_initiating"
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

      const responseBody = await response.json().catch(() => null);

      if (!response.ok || !responseBody || responseBody.status === false) {
        const errorMsg =
          responseBody?.message ||
          `Kora virtual account creation failed (HTTP ${response.status})`;
        logger.error(
          { reference, error: errorMsg },
          "kora.virtual_account_failed"
        );
        throw new Error(errorMsg);
      }

      const data = responseBody.data || {};
      const accountNumber = data.account_number;
      const bankName = data.bank_name || "Kora Virtual Bank";
      const resolvedRef = data.account_reference || reference;

      if (!accountNumber) {
        logger.error(
          { reference },
          "kora.virtual_account_missing_account_number"
        );
        throw new Error(
          "Kora returned virtual account response without account number"
        );
      }

      logger.info(
        {
          reference: resolvedRef,
          accountNumber: maskAccountNumber(accountNumber),
          bankName,
        },
        "kora.virtual_account_created_success"
      );

      return {
        accountNumber,
        bankName,
        reference: resolvedRef,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { reference, err: errMsg },
        "kora.virtual_account_exception"
      );
      throw err;
    }
  }

  async resolveBankAccount(
    bankCode: string,
    accountNumber: string
  ): Promise<BankAccountResolution> {
    const endpoint = `${this.baseUrl}/api/v1/misc/banks/resolve`;

    const requestPayload = {
      bank: bankCode,
      account: accountNumber,
      currency: "NGN",
    };

    logger.info(
      { bankCode, accountNumber: maskAccountNumber(accountNumber) },
      "kora.bank_account_resolution_initiating"
    );

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(8000),
      });

      const responseBody = await response.json().catch(() => null);

      if (!response.ok || !responseBody || responseBody.status === false) {
        const errorMsg =
          responseBody?.message ||
          `Bank account resolution failed (HTTP ${response.status})`;
        logger.warn(
          {
            bankCode,
            accountNumber: maskAccountNumber(accountNumber),
            error: errorMsg,
          },
          "kora.bank_account_resolution_rejected"
        );
        throw new Error(errorMsg);
      }

      const data = responseBody.data || {};
      const accountName = data.account_name;

      if (!accountName) {
        throw new Error("Could not resolve account name from Kora response");
      }

      logger.info(
        { bankCode, accountNumber: maskAccountNumber(accountNumber) },
        "kora.bank_account_resolved_successfully"
      );

      return {
        accountName,
        accountNumber: data.account_number || accountNumber,
        bankCode: data.bank_code || bankCode,
        bankName: data.bank_name,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          bankCode,
          accountNumber: maskAccountNumber(accountNumber),
          err: errMsg,
        },
        "kora.bank_account_resolution_error"
      );
      throw err;
    }
  }

  /**
   * Verify KORA webhook signature.
   *
   * KORA signs ONLY the `data` object of the webhook payload using
   * HMAC-SHA256 with the merchant's secret key. The signature is sent
   * in the `x-korapay-signature` header.
   *
   * Note: the caller (webhook.controller.ts) is responsible for passing
   * `JSON.stringify(body.data)` as `rawBody` — NOT the full request body.
   */
  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!signature || !this.secretKey || !rawBody) {
      return false;
    }

    try {
      const expectedSignature = crypto
        .createHmac("sha256", this.secretKey) // KORA uses SHA-256
        .update(rawBody)
        .digest("hex");

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        logger.warn(
          {
            receivedLength: sigBuffer.length,
            expectedLength: expectedBuffer.length,
          },
          "kora.webhook_signature_length_mismatch"
        );
        return false;
      }

      return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "kora.webhook_signature_compute_failed"
      );
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
          responseBody?.message ||
          `Kora payout rejected (HTTP ${response.status})`;
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
        {
          reference: params.reference,
          isTimeout,
          err: err instanceof Error ? err.message : String(err),
        },
        "kora.payout_request_error — verifying payout status"
      );

      return await this.verifyAndResolvePayout(params.reference);
    }
  }

  async verifyPayout(reference: string): Promise<PayoutStatusQuery> {
    const endpoint = `${this.baseUrl}/api/v1/transactions/${encodeURIComponent(
      reference
    )}`;

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
        data.amount !== undefined
          ? parseFloat(data.amount.toString())
          : undefined;

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
        message:
          err instanceof Error ? err.message : "Verification request failed",
      };
    }
  }

  private async verifyAndResolvePayout(
    reference: string
  ): Promise<PayoutResponse> {
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
        message:
          query.message ||
          "Payout verified as FAILED following initial timeout",
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
