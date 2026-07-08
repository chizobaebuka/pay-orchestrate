import crypto from "crypto";
import { ProviderName, TransactionStatus } from "../db/entities/transaction";
import {
    PaymentProviderAdapter,
    PaymentInitiateParams,
    PaymentInitiateResult,
    PaymentVerifyResult,
    WebhookEvent,
} from "./provider-adapter.interface";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function mapPaystackStatus(status: string): TransactionStatus {
    switch (status) {
        case "success":
            return TransactionStatus.SUCCEEDED;
        case "failed":
        case "abandoned":
            return TransactionStatus.FAILED;
        default:
            return TransactionStatus.PENDING;
    }
}

async function paystackRequest(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_TEST_SECRET}`,
            "Content-Type": "application/json",
            ...init?.headers,
        },
    });

    const body = (await response.json()) as any;

    if (!response.ok || body.status === false) {
        throw new Error(body.message || `Paystack request failed with status ${response.status}`);
    }

    return body;
}

export const paystackAdapter: PaymentProviderAdapter = {
    name: ProviderName.PAYSTACK,

    async initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult> {
        const body = await paystackRequest("/transaction/initialize", {
            method: "POST",
            body: JSON.stringify({
                email: params.customerEmail,
                amount: Math.round(params.amount * 100), // Paystack expects the smallest currency unit
                currency: params.currency.toUpperCase(),
                metadata: params.metadata,
            }),
        });

        return {
            providerReference: body.data.reference,
            status: TransactionStatus.PENDING, // resolves once the customer completes redirectUrl
            redirectUrl: body.data.authorization_url,
            raw: body.data,
        };
    },

    async verify(providerReference: string): Promise<PaymentVerifyResult> {
        const body = await paystackRequest(`/transaction/verify/${encodeURIComponent(providerReference)}`);

        return {
            providerReference: body.data.reference,
            status: mapPaystackStatus(body.data.status),
            amount: body.data.amount / 100,
            currency: body.data.currency,
            raw: body.data,
        };
    },

    handleWebhook(payload: string | Buffer, signature: string): WebhookEvent {
        const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
        const expectedSignature = crypto
            .createHmac("sha512", process.env.PAYSTACK_TEST_SECRET as string)
            .update(rawBody)
            .digest("hex");

        const expected = Buffer.from(expectedSignature, "utf8");
        const received = Buffer.from(signature ?? "", "utf8");

        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
            throw new Error("Invalid Paystack webhook signature");
        }

        const event = JSON.parse(rawBody);

        return {
            type: event.event,
            providerReference: event.data.reference,
            status: mapPaystackStatus(event.data.status),
            raw: event,
        };
    },
};
