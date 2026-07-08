import { ProviderName, TransactionStatus } from "../db/entities/transaction";

export interface PaymentInitiateParams {
    amount: number; // major currency unit, e.g. 50.00 for NGN 50.00
    currency: string;
    customerEmail?: string;
    metadata?: Record<string, unknown>;
}

export interface PaymentInitiateResult {
    providerReference: string;
    status: TransactionStatus;
    redirectUrl?: string; // set when the customer must be redirected to complete payment (e.g. Paystack)
    raw?: unknown;
}

export interface PaymentVerifyResult {
    providerReference: string;
    status: TransactionStatus;
    amount: number;
    currency: string;
    raw?: unknown;
}

export interface WebhookEvent {
    type: string;
    providerReference: string;
    status: TransactionStatus;
    raw?: unknown;
}

export interface PaymentProviderAdapter {
    name: ProviderName;
    initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult>;
    verify(providerReference: string): Promise<PaymentVerifyResult>;
    handleWebhook(payload: string | Buffer, signature: string): WebhookEvent;
}
