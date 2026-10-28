/**
 * OpenAPI 3.0 document for the C-Transit backend.
 * Served via Swagger UI at /api/docs and /docs.
 */

export const openApiDocument: Record<string, unknown> = {
  openapi: "3.0.3",
  info: {
    title: "C-Transit Backend API",
    version: "1.0.0",
    description:
      "REST API for the C-Transit campus transport platform: students, agents, drivers, " +
      "wallets, KYC, disputes, notifications, and driver payouts.",
  },
  servers: [
    { url: "https://c-transit-pink.vercel.app", description: "Production" },
    { url: "http://localhost:3000", description: "Local" },
  ],
  tags: [
    { name: "Health" },
    { name: "Auth" },
    { name: "Users" },
    { name: "KYC" },
    { name: "Wallets" },
    { name: "Payments" },
    { name: "Transactions" },
    { name: "Agents" },
    { name: "Disputes" },
    { name: "Notifications" },
    { name: "Drivers" },
    { name: "Driver Payouts" },
    { name: "Admin" },
    { name: "Internal" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      adminSecret: {
        type: "apiKey",
        in: "header",
        name: "x-admin-secret",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          message: { type: "string" },
        },
      },
      Bank: {
        type: "object",
        properties: {
          name: { type: "string", example: "GTBank" },
          code: { type: "string", example: "058" },
        },
      },
      ResolvedBank: {
        type: "object",
        properties: {
          accountName: { type: "string", example: "JOHN DOE" },
          accountNumber: { type: "string", example: "0123456789" },
          bankCode: { type: "string", example: "058" },
          bankName: { type: "string", example: "GTBank" },
        },
      },
      Withdrawal: {
        type: "object",
        properties: {
          id: { type: "string" },
          amount: { type: "number", example: 1000 },
          fee: { type: "number", example: 40 },
          netAmount: { type: "number", example: 960 },
          status: {
            type: "string",
            enum: ["PENDING", "PROCESSING", "SUCCESS", "FAILED", "CANCELLED"],
          },
          reference: { type: "string" },
          remarks: { type: "string" },
          failureReason: { type: "string", nullable: true },
          koraReference: { type: "string", nullable: true },
          account_number: { type: "string" },
          account_name: { type: "string" },
          bank_name: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: { tags: ["Health"], summary: "Liveness/readiness check", responses: { "200": { description: "Healthy" }, "503": { description: "Degraded" } } },
    },
    "/api/health": {
      get: { tags: ["Health"], summary: "Liveness/readiness check (alias)", responses: { "200": { description: "Healthy" }, "503": { description: "Degraded" } } },
    },
    "/api/auth/register": {
      post: { tags: ["Auth"], summary: "Register student", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "OTP sent" } } },
    },
    "/api/auth/verify-otp": {
      post: { tags: ["Auth"], summary: "Verify registration OTP", responses: { "200": { description: "Verified" } } },
    },
    "/api/auth/resend-otp": {
      post: { tags: ["Auth"], summary: "Resend OTP", responses: { "200": { description: "Sent" } } },
    },
    "/api/auth/login": {
      post: { tags: ["Auth"], summary: "Student login", responses: { "200": { description: "JWT issued" } } },
    },
    "/api/auth/logout": {
      post: { tags: ["Auth"], summary: "Logout", security: [{ bearerAuth: [] }], responses: { "200": { description: "Logged out" } } },
    },
    "/api/auth/refresh": {
      post: { tags: ["Auth"], summary: "Refresh access token", responses: { "200": { description: "New tokens" } } },
    },
    "/api/auth/confirm-card": {
      post: { tags: ["Auth"], summary: "Confirm linked card", security: [{ bearerAuth: [] }], responses: { "200": { description: "Confirmed" } } },
    },
    "/api/auth/card-link-status": {
      get: { tags: ["Auth"], summary: "Card link status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Status" } } },
    },
    "/api/auth/admin/login": {
      post: { tags: ["Auth"], summary: "Admin login", responses: { "200": { description: "JWT issued" } } },
    },
    "/api/users/forgot-password": {
      post: { tags: ["Users"], summary: "Request password reset", responses: { "200": { description: "Sent" } } },
    },
    "/api/users/reset-password": {
      post: { tags: ["Users"], summary: "Reset password", responses: { "200": { description: "Reset" } } },
    },
    "/api/users/count": {
      get: { tags: ["Users"], summary: "User count", security: [{ bearerAuth: [] }], responses: { "200": { description: "Count" } } },
    },
    "/api/users": {
      get: { tags: ["Users"], summary: "List users", security: [{ bearerAuth: [] }], responses: { "200": { description: "Users" } } },
    },
    "/api/users/myprofile": {
      get: { tags: ["Users"], summary: "My profile", security: [{ bearerAuth: [] }], responses: { "200": { description: "Profile" } } },
    },
    "/api/users/update-profile": {
      patch: { tags: ["Users"], summary: "Update profile", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/users/change-password": {
      patch: { tags: ["Users"], summary: "Change password", security: [{ bearerAuth: [] }], responses: { "200": { description: "Changed" } } },
    },
    "/api/kyc/submit": {
      post: { tags: ["KYC"], summary: "Submit KYC", security: [{ bearerAuth: [] }], responses: { "200": { description: "Submitted" } } },
    },
    "/api/kyc/status": {
      get: { tags: ["KYC"], summary: "KYC status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Status" } } },
    },
    "/api/wallets/link": {
      post: { tags: ["Wallets"], summary: "Link wallet", security: [{ bearerAuth: [] }], responses: { "200": { description: "Linked" } } },
    },
    "/api/wallets/details": {
      get: { tags: ["Wallets"], summary: "Wallet details", security: [{ bearerAuth: [] }], responses: { "200": { description: "Details" } } },
    },
    "/api/payments/webhook": {
      post: { tags: ["Payments"], summary: "Payment webhook (Kora)", responses: { "200": { description: "Received" } } },
    },
    "/api/payments/payout-webhook": {
      post: { tags: ["Payments"], summary: "Payout webhook (Kora)", responses: { "200": { description: "Received" } } },
    },
    "/api/payments/initialize": {
      post: { tags: ["Payments"], summary: "Initialize checkout", security: [{ bearerAuth: [] }], responses: { "200": { description: "Initialized" } } },
    },
    "/api/payments/status/{reference}": {
      get: { tags: ["Payments"], summary: "Checkout status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Status" } } },
    },
    "/api/payments/history": {
      get: { tags: ["Payments"], summary: "Topup history", security: [{ bearerAuth: [] }], responses: { "200": { description: "History" } } },
    },
    "/api/payments/requery/{reference}": {
      post: { tags: ["Payments"], summary: "Requery topup", security: [{ bearerAuth: [] }], responses: { "200": { description: "Result" } } },
    },
    "/api/transactions/history": {
      get: { tags: ["Transactions"], summary: "Transaction history", security: [{ bearerAuth: [] }], responses: { "200": { description: "History" } } },
    },
    "/api/agents/login": {
      post: { tags: ["Agents"], summary: "Agent login", responses: { "200": { description: "JWT issued" } } },
    },
    "/api/agents/kyc/pending": {
      get: { tags: ["Agents"], summary: "Pending KYC", security: [{ bearerAuth: [] }], responses: { "200": { description: "List" } } },
    },
    "/api/agents/kyc/{userId}/approve": {
      post: { tags: ["Agents"], summary: "Approve KYC", security: [{ bearerAuth: [] }], responses: { "200": { description: "Approved" } } },
    },
    "/api/agents/kyc/{userId}/reject": {
      post: { tags: ["Agents"], summary: "Reject KYC", security: [{ bearerAuth: [] }], responses: { "200": { description: "Rejected" } } },
    },
    "/api/agents/drivers": {
      get: { tags: ["Agents"], summary: "List drivers", security: [{ bearerAuth: [] }], responses: { "200": { description: "Drivers" } } },
    },
    "/api/agents/drivers/register": {
      post: { tags: ["Agents"], summary: "Register driver", security: [{ bearerAuth: [] }], responses: { "200": { description: "Registered" } } },
    },
    "/api/agents/terminals": {
      get: { tags: ["Agents"], summary: "List terminals", security: [{ bearerAuth: [] }], responses: { "200": { description: "Terminals" } } },
    },
    "/api/agents/card/link": {
      post: { tags: ["Agents"], summary: "Link card", security: [{ bearerAuth: [] }], responses: { "200": { description: "Linked" } } },
    },
    "/api/agents/card/unlink": {
      post: { tags: ["Agents"], summary: "Unlink card", security: [{ bearerAuth: [] }], responses: { "200": { description: "Unlinked" } } },
    },
    "/api/agents/users": {
      get: { tags: ["Agents"], summary: "List users", security: [{ bearerAuth: [] }], responses: { "200": { description: "Users" } } },
    },
    "/api/agents/users/{matricNumber}/transactions": {
      get: { tags: ["Agents"], summary: "Student transactions", security: [{ bearerAuth: [] }], responses: { "200": { description: "Transactions" } } },
    },
    "/api/disputes": {
      get: { tags: ["Disputes"], summary: "List disputes", security: [{ bearerAuth: [] }], responses: { "200": { description: "Disputes" } } },
    },
    "/api/notifications": {
      get: { tags: ["Notifications"], summary: "List notifications", security: [{ bearerAuth: [] }], responses: { "200": { description: "Notifications" } } },
    },
    "/api/notifications/{id}/read": {
      patch: { tags: ["Notifications"], summary: "Mark notification read", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/notifications/{id}/mark-read": {
      patch: { tags: ["Notifications"], summary: "Mark notification read (alias)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/notifications/mark-all-read": {
      patch: { tags: ["Notifications"], summary: "Mark all notifications read", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/drivers/login": {
      post: { tags: ["Drivers"], summary: "Driver login (phone + PIN)", responses: { "200": { description: "JWT issued" } } },
    },
    "/api/drivers/me": {
      get: { tags: ["Drivers"], summary: "Driver profile", security: [{ bearerAuth: [] }], responses: { "200": { description: "Profile" } } },
    },
    "/api/drivers/dashboard": {
      get: { tags: ["Drivers"], summary: "Driver dashboard", security: [{ bearerAuth: [] }], responses: { "200": { description: "Dashboard" } } },
    },
    "/api/drivers/rides": {
      get: { tags: ["Drivers"], summary: "Driver rides", security: [{ bearerAuth: [] }], responses: { "200": { description: "Rides" } } },
    },
    "/api/drivers/card/link": {
      post: { tags: ["Drivers"], summary: "Link terminal card", security: [{ bearerAuth: [] }], responses: { "200": { description: "Linked" } } },
    },
    "/api/drivers/card/pin": {
      post: { tags: ["Drivers"], summary: "Set terminal PIN", security: [{ bearerAuth: [] }], responses: { "200": { description: "Set" } } },
    },
    "/api/drivers/card/unlink": {
      post: { tags: ["Drivers"], summary: "Unlink terminal card", security: [{ bearerAuth: [] }], responses: { "200": { description: "Unlinked" } } },
    },
    "/api/drivers/card/pin/status": {
      get: { tags: ["Drivers"], summary: "PIN status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Status" } } },
    },
    "/api/drivers/notifications": {
      get: { tags: ["Drivers"], summary: "Driver notifications", security: [{ bearerAuth: [] }], responses: { "200": { description: "Notifications" } } },
    },
    "/api/drivers/notifications/{id}/read": {
      patch: { tags: ["Drivers"], summary: "Mark notification read", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/drivers/notifications/{id}/mark-read": {
      patch: { tags: ["Drivers"], summary: "Mark notification read (alias)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/drivers/notifications/mark-all-read": {
      patch: { tags: ["Drivers"], summary: "Mark all notifications read", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/drivers/banks": {
      get: {
        tags: ["Driver Payouts"],
        summary: "List supported banks (name + code)",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Bank list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { type: "array", items: { $ref: "#/components/schemas/Bank" } },
                    banks: { type: "array", items: { $ref: "#/components/schemas/Bank" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/drivers/bank/resolve": {
      post: {
        tags: ["Driver Payouts"],
        summary: "Resolve account name (read-only preview, no PIN)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["bankCode", "accountNumber"],
                properties: {
                  bankCode: { type: "string", example: "058" },
                  accountNumber: { type: "string", minLength: 10, maxLength: 10, example: "0123456789" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Resolved account",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { $ref: "#/components/schemas/ResolvedBank" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid bank or account number" },
          "429": { description: "Too many lookups" },
        },
      },
    },
    "/api/drivers/bank/verify": {
      post: {
        tags: ["Driver Payouts"],
        summary: "Verify and save payout account (PIN required)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["bankCode", "accountNumber", "pin"],
                properties: {
                  bankCode: { type: "string", example: "058" },
                  accountNumber: { type: "string", example: "0123456789" },
                  pin: { type: "string", pattern: "^\\d{4}$", example: "1234" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Account saved" },
          "400": { description: "Invalid input, PIN format, or incorrect PIN" },
          "429": { description: "Too many attempts" },
        },
      },
    },
    "/api/drivers/withdraw": {
      post: {
        tags: ["Driver Payouts"],
        summary: "Request withdrawal to verified bank (PIN required)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount", "pin"],
                properties: {
                  amount: { type: "number", minimum: 1, example: 5000 },
                  pin: { type: "string", pattern: "^\\d{4}$", example: "1234" },
                  remarks: { type: "string", example: "Monday shift" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Withdrawal submitted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { $ref: "#/components/schemas/Withdrawal" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid amount, insufficient balance, unverified bank, or incorrect PIN" },
          "429": { description: "Too many attempts" },
        },
      },
    },
    "/api/drivers/withdrawals": {
      get: {
        tags: ["Driver Payouts"],
        summary: "List driver withdrawals",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: {
          "200": {
            description: "Withdrawals",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { type: "array", items: { $ref: "#/components/schemas/Withdrawal" } },
                    withdrawals: { type: "array", items: { $ref: "#/components/schemas/Withdrawal" } },
                    pagination: {
                      type: "object",
                      properties: {
                        page: { type: "integer", example: 1 },
                        limit: { type: "integer", example: 20 },
                        total: { type: "integer", example: 42 },
                        totalPages: { type: "integer", example: 3 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/drivers/payout-webhook": {
      post: { tags: ["Driver Payouts"], summary: "Driver payout webhook (Kora)", responses: { "200": { description: "Received" } } },
    },
    "/api/admin/agents": {
      get: { tags: ["Admin"], summary: "List agents", security: [{ bearerAuth: [] }], responses: { "200": { description: "Agents" } } },
      post: { tags: ["Admin"], summary: "Create agent", security: [{ bearerAuth: [] }], responses: { "200": { description: "Created" } } },
    },
    "/api/admin/agents/{id}": {
      get: { tags: ["Admin"], summary: "Get agent", security: [{ bearerAuth: [] }], responses: { "200": { description: "Agent" } } },
    },
    "/api/admin/agents/{id}/status": {
      patch: { tags: ["Admin"], summary: "Update agent status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/admin/overview": {
      get: { tags: ["Admin"], summary: "Admin overview", security: [{ bearerAuth: [] }], responses: { "200": { description: "Overview" } } },
    },
    "/api/admin/income": {
      get: { tags: ["Admin"], summary: "Income stats", security: [{ bearerAuth: [] }], responses: { "200": { description: "Stats" } } },
    },
    "/api/admin/terminals": {
      get: { tags: ["Admin"], summary: "List terminals", security: [{ bearerAuth: [] }], responses: { "200": { description: "Terminals" } } },
    },
    "/api/admin/disputes": {
      get: { tags: ["Admin"], summary: "List disputes", security: [{ bearerAuth: [] }], responses: { "200": { description: "Disputes" } } },
    },
    "/api/admin/disputes/{id}": {
      get: { tags: ["Admin"], summary: "Get dispute", security: [{ bearerAuth: [] }], responses: { "200": { description: "Dispute" } } },
    },
    "/api/admin/disputes/{id}/status": {
      patch: { tags: ["Admin"], summary: "Update dispute status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" } } },
    },
    "/api/admin/notifications": {
      post: { tags: ["Admin"], summary: "Send notification", security: [{ bearerAuth: [] }], responses: { "200": { description: "Sent" } } },
    },
    "/api/admin/sync/whitelist": {
      post: { tags: ["Admin"], summary: "Sync whitelist", security: [{ bearerAuth: [] }], responses: { "200": { description: "Synced" } } },
    },
    "/api/admin/card/unlink": {
      post: { tags: ["Admin"], summary: "Admin unlink card", security: [{ bearerAuth: [] }], responses: { "200": { description: "Unlinked" } } },
    },
    "/api/admin/card/link": {
      post: { tags: ["Admin"], summary: "Admin link card", security: [{ bearerAuth: [] }], responses: { "200": { description: "Linked" } } },
    },
    "/api/internal/reconcile-withdrawals": {
      post: {
        tags: ["Internal"],
        summary: "Reconcile stuck withdrawals (cron)",
        security: [{ adminSecret: [] }],
        responses: { "200": { description: "Summary" }, "401": { description: "Unauthorized" } },
      },
    },
  },
};
