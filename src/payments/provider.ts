import crypto from "crypto";
import {
  IPaymentGateway,
  PayoutParams,
  PayoutResponse,
  PayoutStatusQuery,
  BankAccountResolution,
  CheckoutInitializationParams,
  CheckoutInitializationResponse,
  ChargeStatusQuery,
  BankInfo,
} from "./payment.interface.js";
import logger from "../config/logger.js";

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4
    ? `${"*".repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`
    : "****";
}

export interface KoraProviderOptions {
  /** Per-transaction webhook URL sent to Kora on payout requests. */
  payoutWebhookUrl?: string;
  /** Base URL of the static-egress payout proxy, e.g. https://payout.example.com */
  payoutProxyUrl?: string;
  /** Shared secret used to authenticate this backend to the payout proxy. */
  payoutProxySecret?: string;
}

export class KoraProvider implements IPaymentGateway {
  private secretKey: string;
  private publicKey: string;
  private baseUrl: string;
  private payoutWebhookUrl?: string;
  private payoutProxyUrl?: string;
  private payoutProxySecret?: string;

  constructor(
    secretKey: string,
    publicKey?: string,
    baseUrl?: string,
    options: KoraProviderOptions = {}
  ) {
    this.secretKey = secretKey;
    this.publicKey = publicKey;
    this.baseUrl =
      baseUrl ||
      process.env.KORA_BASE_URL ||
      "https://api.korapay.com/merchant";
    this.payoutWebhookUrl = options.payoutWebhookUrl;
    this.payoutProxyUrl = options.payoutProxyUrl?.replace(/\/+$/, "");
    this.payoutProxySecret = options.payoutProxySecret;
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
        ? ` [${body.errors.attribute ?? "unknown_field"}: ${body.errors.message ?? "no detail"
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

  /**
   * Asks Kora for the current state of a checkout charge (GET /charges/:reference).
   * Never throws: any timeout, HTTP error or malformed body returns "unknown",
   * which callers must treat as "could not check", never as a failed payment.
   */
  async verifyCharge(reference: string): Promise<ChargeStatusQuery> {
    const endpoint = `${this.baseUrl}/api/v1/charges/${encodeURIComponent(
      reference
    )}`;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 404) {
        return {
          status: "not_found",
          reference,
          message: "Charge not found on Kora",
        };
      }

      if (!response.ok) {
        return {
          status: "unknown",
          reference,
          message: `Kora charge check returned HTTP ${response.status}`,
        };
      }

      const body = await response.json().catch(() => null);
      if (!body || body.status === false || !body.data) {
        return {
          status: "unknown",
          reference,
          message: body?.message || "Invalid response from Kora charge check",
        };
      }

      const data = body.data;
      const rawStatus = String(data.status ?? "").toLowerCase();
      let status: ChargeStatusQuery["status"] = "unknown";
      if (rawStatus === "success" || rawStatus === "successful") {
        status = "success";
      } else if (rawStatus === "failed") {
        status = "failed";
      } else if (rawStatus === "processing") {
        status = "processing";
      } else if (rawStatus === "pending") {
        status = "pending";
      }

      const parsedAmount =
        data.amount !== undefined ? Number(data.amount) : undefined;

      return {
        status,
        reference,
        amount:
          parsedAmount !== undefined && Number.isFinite(parsedAmount)
            ? parsedAmount
            : undefined,
        currency: typeof data.currency === "string" ? data.currency : undefined,
        message: body.message,
      };
    } catch (err) {
      logger.warn(
        { reference, err: err instanceof Error ? err.message : String(err) },
        "kora.verify_charge_failed"
      );
      return {
        status: "unknown",
        reference,
        message:
          err instanceof Error ? err.message : "Charge verification failed",
      };
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
    const proxyBase = this.payoutProxyUrl;
    const endpoint = proxyBase
      ? `${proxyBase}/disburse`
      : `${this.baseUrl}/api/v1/transactions/disburse`;

    // Per KoraPay API spec, `customer` goes INSIDE `destination`, not at root level.
    // `notification_url` tells KoraPay where to send webhook callbacks for this payout.
    const requestPayload: Record<string, unknown> = {
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
        customer: {
          name: params.customer.name,
          email: params.customer.email,
        },
      },
    };

    // Optional: per-transaction webhook URL (overrides dashboard default).
    // KoraPay's disburse endpoint does not accept `notification_url` in the
    // request body, so omit it. Webhook delivery is configured on the Kora
    // dashboard (or via the payout proxy) instead.
    void this.payoutWebhookUrl;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (proxyBase) {
      headers["x-payout-proxy-secret"] = this.payoutProxySecret || "";
    } else {
      headers.Authorization = `Bearer ${this.secretKey}`;
    }

    logger.info(
      {
        reference: params.reference,
        amount: params.amount,
        viaStaticProxy: Boolean(proxyBase),
      },
      "kora.payout_initiating"
    );

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(proxyBase ? 35000 : 10000),
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
    const proxyBase = this.payoutProxyUrl;
    const endpoint = proxyBase
      ? `${proxyBase}/verify/${encodeURIComponent(reference)}`
      : `${this.baseUrl}/api/v1/transactions/${encodeURIComponent(reference)}`;

    const headers: Record<string, string> = {};
    if (proxyBase) {
      headers["x-payout-proxy-secret"] = this.payoutProxySecret || "";
    } else {
      headers.Authorization = `Bearer ${this.secretKey}`;
    }

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(proxyBase ? 15000 : 8000),
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

  async listBanks(): Promise<BankInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/v1/misc/banks?countryCode=NG`, {
      headers: { Authorization: `Bearer ${this.publicKey}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok || !body || body.status === false || !Array.isArray(body.data)) {
      throw new Error(body?.message || `Kora bank list failed (HTTP ${response.status})`);
    }

    return body.data
      .filter((b: { name?: unknown; code?: unknown }) => b?.name && b?.code)
      .map((b: { name: string; code: string }) => ({ name: String(b.name).trim(), code: String(b.code).trim() }))
      .sort((a: BankInfo, b: BankInfo) => a.name.localeCompare(b.name));
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