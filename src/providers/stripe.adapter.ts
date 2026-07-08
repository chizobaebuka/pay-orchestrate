import Stripe from "stripe";
import { ProviderName, TransactionStatus } from "../db/entities/transaction";
import {
    PaymentProviderAdapter,
    PaymentInitiateParams,
    PaymentInitiateResult,
    PaymentVerifyResult,
    WebhookEvent,
} from "./provider-adapter.interface";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

function mapStripeStatus(status: Stripe.PaymentIntent.Status): TransactionStatus {
    switch (status) {
        case "succeeded":
            return TransactionStatus.SUCCEEDED;
        case "processing":
            return TransactionStatus.PROCESSING;
        case "canceled":
            return TransactionStatus.FAILED;
        default:
            // requires_payment_method, requires_confirmation, requires_action, requires_capture
            return TransactionStatus.PENDING;
    }
}

function toStripeMetadata(metadata?: Record<string, unknown>): Record<string, string> | undefined {
    if (!metadata) return undefined;
    return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)]));
}

export const stripeAdapter: PaymentProviderAdapter = {
    name: ProviderName.STRIPE,

    async initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult> {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(params.amount * 100), // Stripe expects the smallest currency unit
            currency: params.currency.toLowerCase(),
            receipt_email: params.customerEmail,
            metadata: toStripeMetadata(params.metadata),
        });

        return {
            providerReference: paymentIntent.id,
            status: mapStripeStatus(paymentIntent.status),
            raw: paymentIntent,
        };
    },

    async verify(providerReference: string): Promise<PaymentVerifyResult> {
        const paymentIntent = await stripe.paymentIntents.retrieve(providerReference);

        return {
            providerReference: paymentIntent.id,
            status: mapStripeStatus(paymentIntent.status),
            amount: paymentIntent.amount / 100,
            currency: paymentIntent.currency,
            raw: paymentIntent,
        };
    },

    handleWebhook(payload: string | Buffer, signature: string): WebhookEvent {
        const event = stripe.webhooks.constructEvent(
            payload,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET as string
        );

        const paymentIntent = event.data.object as Stripe.PaymentIntent;

        return {
            type: event.type,
            providerReference: paymentIntent.id,
            status: mapStripeStatus(paymentIntent.status),
            raw: event,
        };
    },
};
