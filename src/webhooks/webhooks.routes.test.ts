import express from "express";
import request from "supertest";
import { ProviderName, TransactionStatus } from "../db/entities/transaction";

const mockHandleWebhookStripe = jest.fn();
const mockHandleWebhookPaystack = jest.fn();
const mockQueueAdd = jest.fn();

jest.mock("../providers/stripe.adapter", () => ({
    stripeAdapter: { handleWebhook: (...args: unknown[]) => mockHandleWebhookStripe(...args) },
}));

jest.mock("../providers/paystack.adapter", () => ({
    paystackAdapter: { handleWebhook: (...args: unknown[]) => mockHandleWebhookPaystack(...args) },
}));

jest.mock("../queues/reconciliation.queue", () => ({
    reconciliationQueue: { add: (...args: unknown[]) => mockQueueAdd(...args) },
}));

import webhooksRoutes from "./webhooks.routes";

// Mounted with no express.json() ahead of it, matching production wiring — the routes'
// own express.raw() middleware is what's actually under test here.
const app = express();
app.use("/webhooks", webhooksRoutes);

describe("POST /webhooks/stripe", () => {
    it("rejects a request with no stripe-signature header, before touching the adapter", async () => {
        const res = await request(app)
            .post("/webhooks/stripe")
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ foo: "bar" }));

        expect(res.status).toBe(400);
        expect(mockHandleWebhookStripe).not.toHaveBeenCalled();
        expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("enqueues a reconciliation job for a validly signed event and responds immediately", async () => {
        mockHandleWebhookStripe.mockReturnValue({
            type: "payment_intent.succeeded",
            providerReference: "pi_1",
            status: TransactionStatus.SUCCEEDED,
        });

        const res = await request(app)
            .post("/webhooks/stripe")
            .set("Content-Type", "application/json")
            .set("stripe-signature", "valid-sig")
            .send(JSON.stringify({ id: "evt_1" }));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });
        expect(mockQueueAdd).toHaveBeenCalledWith("reconcile", {
            provider: ProviderName.STRIPE,
            providerReference: "pi_1",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });
    });

    it("returns 400 and never enqueues when signature verification throws", async () => {
        mockHandleWebhookStripe.mockImplementation(() => {
            throw new Error("bad signature");
        });

        const res = await request(app)
            .post("/webhooks/stripe")
            .set("Content-Type", "application/json")
            .set("stripe-signature", "bad-sig")
            .send(JSON.stringify({ id: "evt_1" }));

        expect(res.status).toBe(400);
        expect(mockQueueAdd).not.toHaveBeenCalled();
    });
});

describe("POST /webhooks/paystack", () => {
    it("rejects a request with no x-paystack-signature header", async () => {
        const res = await request(app)
            .post("/webhooks/paystack")
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ foo: "bar" }));

        expect(res.status).toBe(400);
        expect(mockHandleWebhookPaystack).not.toHaveBeenCalled();
    });

    it("enqueues a reconciliation job for a validly signed event", async () => {
        mockHandleWebhookPaystack.mockReturnValue({
            type: "charge.success",
            providerReference: "ref_1",
            status: TransactionStatus.SUCCEEDED,
        });

        const res = await request(app)
            .post("/webhooks/paystack")
            .set("Content-Type", "application/json")
            .set("x-paystack-signature", "valid-sig")
            .send(JSON.stringify({ event: "charge.success" }));

        expect(res.status).toBe(200);
        expect(mockQueueAdd).toHaveBeenCalledWith("reconcile", {
            provider: ProviderName.PAYSTACK,
            providerReference: "ref_1",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });
    });

    it("returns 400 and never enqueues when signature verification throws", async () => {
        mockHandleWebhookPaystack.mockImplementation(() => {
            throw new Error("Invalid Paystack webhook signature");
        });

        const res = await request(app)
            .post("/webhooks/paystack")
            .set("Content-Type", "application/json")
            .set("x-paystack-signature", "bad-sig")
            .send(JSON.stringify({ event: "charge.success" }));

        expect(res.status).toBe(400);
        expect(mockQueueAdd).not.toHaveBeenCalled();
    });
});
