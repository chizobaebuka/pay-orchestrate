/**
 * Hand-written OpenAPI 3.0 spec, not JSDoc-comment-generated — kept as a single source of
 * truth here rather than scattered across route files, since the interesting behavior
 * (idempotency semantics, webhook signature requirements, reconciliation-driven status
 * transitions) needs real prose, not just a type shape.
 */
export const openApiSpec = {
    openapi: "3.0.3",
    info: {
        title: "pay-orchestrate API",
        version: "1.0.0",
        description: `
A payment orchestration service that sits between your application and multiple payment
processors (Stripe, Paystack), giving you one consistent API regardless of which provider
actually processes a given transaction.

**Idempotency.** Every \`POST /api/payments\` request requires an \`Idempotency-Key\` header.
Retrying the same key never causes a second charge: a fresh key proceeds normally, a key
that's mid-flight returns \`409\`, and a key that already completed returns the original
result instead of re-processing.

**Webhooks are a trigger to re-check, not a source of truth.** Signature verification alone
proves a webhook came from the provider — it doesn't prove the amount inside it is correct.
After signature verification, this service independently re-verifies the transaction
directly against the provider's API before ever marking anything as reconciled. A mismatch
between what was initiated and what the provider confirms is flagged \`mismatched\` rather
than silently trusted.
        `.trim(),
    },
    servers: [{ url: "/", description: "Current host (works for both local dev and the deployed instance)" }],
    tags: [
        { name: "System", description: "Health and liveness" },
        { name: "Payments", description: "Initiate and inspect payments" },
        { name: "Webhooks", description: "Provider-signed callbacks — not meant to be called manually" },
    ],
    paths: {
        "/health": {
            get: {
                tags: ["System"],
                summary: "Liveness check",
                description: "Pings both Postgres and Redis directly rather than just confirming the process is up.",
                responses: {
                    "200": {
                        description: "Service and its dependencies are reachable (individual dependencies may still report \"down\")",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
                        },
                    },
                },
            },
        },
        "/api/payments": {
            post: {
                tags: ["Payments"],
                summary: "Initiate a payment",
                description:
                    "Calls the selected provider to create a charge/checkout, persists a transaction row, and returns immediately — the transaction starts in `pending` and transitions to `reconciled`, `mismatched`, or `failed` once the provider's webhook is received and independently re-verified. Requires an `Idempotency-Key` header; see the top-level description for the exact semantics.",
                parameters: [
                    {
                        name: "Idempotency-Key",
                        in: "header",
                        required: true,
                        description: "Client-generated unique key for this payment attempt. Reusing a key never causes a duplicate charge.",
                        schema: { type: "string", example: "order-4471-attempt-1" },
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": { schema: { $ref: "#/components/schemas/PaymentRequest" } },
                    },
                },
                responses: {
                    "202": {
                        description: "Payment accepted and forwarded to the provider",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/PaymentAcceptedResponse" } },
                        },
                    },
                    "200": {
                        description: "Duplicate request for a key that already completed — returns the original result, no new charge was attempted",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/DuplicateResultResponse" } },
                        },
                    },
                    "400": {
                        description: "Missing/invalid `Idempotency-Key` header, missing `amount`/`currency`, or an unsupported `provider`",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "409": {
                        description: "A request with this idempotency key is already being processed concurrently",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "502": {
                        description: "The provider API call itself failed (network error, provider rejected the request, etc.) — the idempotency key is released so the same key can be safely retried",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/api/transactions": {
            get: {
                tags: ["Payments"],
                summary: "List recent transactions",
                description: "Returns the 20 most recently updated transactions. Backs the live dashboard's initial load; ongoing updates arrive over Socket.IO instead of polling this endpoint.",
                responses: {
                    "200": {
                        description: "Most recent transactions, newest first",
                        content: {
                            "application/json": {
                                schema: { type: "array", items: { $ref: "#/components/schemas/Transaction" } },
                            },
                        },
                    },
                },
            },
        },
        "/webhooks/stripe": {
            post: {
                tags: ["Webhooks"],
                summary: "Stripe webhook receiver",
                description:
                    "Not meant to be called directly — Stripe calls this with events signed using your webhook signing secret. The signature is verified against the **raw, unparsed** request body (this route is deliberately mounted before JSON body-parsing). On success, a reconciliation job is enqueued and the response returns immediately; the actual transaction status update happens asynchronously once the job independently re-verifies with Stripe's API.",
                parameters: [
                    {
                        name: "stripe-signature",
                        in: "header",
                        required: true,
                        description: "HMAC signature generated by Stripe, verified with `stripe.webhooks.constructEvent`",
                        schema: { type: "string" },
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { type: "object", description: "Raw Stripe Event payload — shape varies by event type" },
                        },
                    },
                },
                responses: {
                    "200": {
                        description: "Signature verified and reconciliation job enqueued",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookAck" } } },
                    },
                    "400": {
                        description: "Missing or invalid `stripe-signature` header",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/webhooks/paystack": {
            post: {
                tags: ["Webhooks"],
                summary: "Paystack webhook receiver",
                description:
                    "Not meant to be called directly — Paystack calls this with events signed via HMAC-SHA512 over the raw request body using your Paystack secret key. Verified with a constant-time comparison (`crypto.timingSafeEqual`) to avoid timing side-channels. On success, a reconciliation job is enqueued and the response returns immediately.",
                parameters: [
                    {
                        name: "x-paystack-signature",
                        in: "header",
                        required: true,
                        description: "HMAC-SHA512 signature of the raw request body",
                        schema: { type: "string" },
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { type: "object", description: "Raw Paystack event payload — shape varies by event type" },
                        },
                    },
                },
                responses: {
                    "200": {
                        description: "Signature verified and reconciliation job enqueued",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookAck" } } },
                    },
                    "400": {
                        description: "Missing or invalid `x-paystack-signature` header",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
    },
    components: {
        schemas: {
            ProviderName: {
                type: "string",
                enum: ["stripe", "paystack"],
                description: "Which payment processor handled (or should handle) this transaction",
            },
            TransactionStatus: {
                type: "string",
                enum: ["pending", "processing", "succeeded", "failed", "reconciled", "mismatched"],
                description:
                    "`pending`/`processing` — awaiting provider confirmation. `succeeded` — the provider reported success but this service hasn't independently re-verified it yet (transient). " +
                    "`reconciled` — independently re-verified against the provider's API and the amount/currency matched what was initiated (the trustworthy \"done\" state). " +
                    "`mismatched` — the provider confirmed success but the amount or currency disagreed with what was initiated; investigate before treating this as paid. " +
                    "`failed` — the provider reported the payment failed or was canceled.",
            },
            HealthResponse: {
                type: "object",
                properties: {
                    status: { type: "string", example: "ok" },
                    db: { type: "string", example: "ok" },
                    redis: { type: "string", enum: ["ok", "down"], example: "ok" },
                },
            },
            Transaction: {
                type: "object",
                properties: {
                    id: { type: "string", format: "uuid" },
                    idempotencyKey: { type: "string" },
                    provider: { $ref: "#/components/schemas/ProviderName" },
                    providerReference: {
                        type: "string",
                        nullable: true,
                        description: "The ID the provider itself uses for this transaction (e.g. a Stripe PaymentIntent ID or a Paystack reference)",
                    },
                    status: { $ref: "#/components/schemas/TransactionStatus" },
                    amount: { type: "string", example: "20.00", description: "Decimal string, major currency unit (e.g. dollars, not cents)" },
                    currency: { type: "string", example: "USD" },
                    customerEmail: { type: "string", format: "email", nullable: true },
                    metadata: { type: "object", nullable: true, additionalProperties: true },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            PaymentRequest: {
                type: "object",
                required: ["amount", "currency"],
                properties: {
                    amount: { type: "number", example: 20.0, description: "Major currency unit (e.g. dollars, not cents) — converted to the provider's smallest unit internally" },
                    currency: { type: "string", example: "USD" },
                    customerEmail: { type: "string", format: "email" },
                    provider: { $ref: "#/components/schemas/ProviderName", default: "stripe" },
                    metadata: { type: "object", additionalProperties: true },
                },
            },
            PaymentAcceptedResponse: {
                type: "object",
                properties: {
                    message: { type: "string", example: "Payment accepted for processing" },
                    transactionId: { type: "string", format: "uuid" },
                    providerReference: { type: "string" },
                    status: { $ref: "#/components/schemas/TransactionStatus" },
                    redirectUrl: {
                        type: "string",
                        nullable: true,
                        description: "Present for providers that require the customer to complete payment on a hosted page (e.g. Paystack). Absent for providers confirmed directly server-side (e.g. Stripe).",
                    },
                },
            },
            DuplicateResultResponse: {
                type: "object",
                properties: {
                    message: { type: "string", example: "Duplicate request — returning original result" },
                    transactionId: { type: "string", format: "uuid" },
                },
            },
            WebhookAck: {
                type: "object",
                properties: { received: { type: "boolean", example: true } },
            },
            ErrorResponse: {
                type: "object",
                properties: { error: { type: "string" } },
            },
        },
    },
} as const;
