import crypto from "crypto";
import { ProviderName, TransactionStatus } from "../db/entities/transaction";
import {
    PaymentProviderAdapter,
    PaymentInitiateParams,
    PaymentInitiateResult,
    PaymentVerifyResult,
    WebhookEvent,
} from "./provider-adapter.interface";

const IDP_BASE_URL = "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";
const API_BASE_URL = "https://developersandbox-api.flutterwave.com";

// v4 is OAuth2 (client_credentials), not a static secret key — tokens expire (~10 min in
// sandbox), so cache and refresh rather than fetching one per request.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken.value;
    }

    const response = await fetch(IDP_BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: process.env.FW_TEST_CLIENT_ID as string,
            client_secret: process.env.FW_TEST_CLIENT_SECRET as string,
        }),
    });

    const body = (await response.json()) as any;

    if (!response.ok) {
        throw new Error(body.error_description || "Failed to obtain Flutterwave access token");
    }

    // Refresh a bit early rather than racing the actual expiry.
    cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 };
    return cachedToken.value;
}

async function flutterwaveRequest(path: string, init?: RequestInit): Promise<any> {
    const token = await getAccessToken();

    const response = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Trace-Id": crypto.randomUUID(),
            "X-Idempotency-Key": crypto.randomUUID(),
            ...init?.headers,
        },
    });

    const body = (await response.json()) as any;

    if (!response.ok || body.status === "error") {
        throw new Error(body.message || `Flutterwave request failed with status ${response.status}`);
    }

    return body;
}

function mapChargeStatus(status: string): TransactionStatus {
    switch (status) {
        case "succeeded":
            return TransactionStatus.SUCCEEDED;
        case "failed":
            return TransactionStatus.FAILED;
        default:
            return TransactionStatus.PENDING;
    }
}

export const flutterwaveAdapter: PaymentProviderAdapter = {
    name: ProviderName.FLUTTERWAVE,

    // Pay With Bank Transfer: the only v4 payment method needing no instrument-specific
    // details (no card/phone/bank-code input) — fits this service's generic initiate()
    // shape. Trade-off: returns bank transfer instructions to display, not a redirect link.
    async initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult> {
        if (!params.customerEmail) {
            throw new Error("customerEmail is required to initiate a Flutterwave payment");
        }

        const customer = await flutterwaveRequest("/customers", {
            method: "POST",
            body: JSON.stringify({ email: params.customerEmail }),
        });

        const reference = crypto.randomUUID();

        // Flutterwave v4 uses major currency units directly (e.g. 1500 = NGN 1,500),
        // unlike Stripe/Paystack's smallest-unit convention — confirmed against the real
        // sandbox API rather than assumed, since copying the *100 pattern here would have
        // silently overcharged by 100x.
        const virtualAccount = await flutterwaveRequest("/virtual-accounts", {
            method: "POST",
            body: JSON.stringify({
                reference,
                customer_id: customer.data.id,
                amount: params.amount,
                currency: params.currency.toUpperCase(),
                account_type: "dynamic",
                narration: (params.metadata?.narration as string) || "Payment",
            }),
        });

        return {
            providerReference: reference,
            status: TransactionStatus.PENDING,
            paymentInstructions: `Transfer ${params.currency.toUpperCase()} ${params.amount} to account ${virtualAccount.data.account_number} (${virtualAccount.data.account_bank_name})`,
            raw: virtualAccount.data,
        };
    },

    async verify(providerReference: string): Promise<PaymentVerifyResult> {
        const body = await flutterwaveRequest(`/charges?reference=${encodeURIComponent(providerReference)}`);
        const charge = body.data?.[0];

        if (!charge) {
            // No charge yet — the customer hasn't completed the bank transfer. amount/currency
            // are placeholders; the reconciliation worker only compares them once status is
            // SUCCEEDED, so this is safe.
            return { providerReference, status: TransactionStatus.PENDING, amount: 0, currency: "" };
        }

        return {
            providerReference: charge.reference,
            status: mapChargeStatus(charge.status),
            amount: charge.amount,
            currency: charge.currency,
            raw: charge,
        };
    },

    handleWebhook(payload: string | Buffer, signature: string): WebhookEvent {
        const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
        const expectedSignature = crypto
            .createHmac("sha256", process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH as string)
            .update(rawBody)
            .digest("base64");

        const expected = Buffer.from(expectedSignature, "utf8");
        const received = Buffer.from(signature ?? "", "utf8");

        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
            throw new Error("Invalid Flutterwave webhook signature");
        }

        const event = JSON.parse(rawBody);
        const charge = event.data;

        return {
            type: event.type,
            providerReference: charge.reference,
            status: mapChargeStatus(charge.status),
            raw: event,
        };
    },
};
