import { TransactionStatus } from "../db/entities/transaction";

const mockCreate = jest.fn();
const mockRetrieve = jest.fn();
const mockConstructEvent = jest.fn();

jest.mock("stripe", () => {
    return jest.fn().mockImplementation(() => ({
        paymentIntents: {
            create: mockCreate,
            retrieve: mockRetrieve,
        },
        webhooks: {
            constructEvent: mockConstructEvent,
        },
    }));
});

import { stripeAdapter } from "./stripe.adapter";

const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});

afterAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
});

describe("stripeAdapter", () => {
    describe("initiate", () => {
        it("creates a PaymentIntent in the smallest currency unit and maps the initial status", async () => {
            mockCreate.mockResolvedValue({ id: "pi_123", status: "requires_payment_method" });

            const result = await stripeAdapter.initiate({
                amount: 20,
                currency: "USD",
                customerEmail: "a@b.com",
            });

            expect(mockCreate).toHaveBeenCalledWith(
                expect.objectContaining({ amount: 2000, currency: "usd", receipt_email: "a@b.com" })
            );
            expect(result).toEqual(
                expect.objectContaining({ providerReference: "pi_123", status: TransactionStatus.PENDING })
            );
        });

        it("converts metadata values to strings, as Stripe requires", async () => {
            mockCreate.mockResolvedValue({ id: "pi_1", status: "processing" });

            await stripeAdapter.initiate({
                amount: 1,
                currency: "usd",
                metadata: { orderId: 42, flagged: true },
            });

            expect(mockCreate).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: { orderId: "42", flagged: "true" } })
            );
        });
    });

    describe("verify", () => {
        it.each([
            ["succeeded", TransactionStatus.SUCCEEDED],
            ["processing", TransactionStatus.PROCESSING],
            ["canceled", TransactionStatus.FAILED],
            ["requires_action", TransactionStatus.PENDING],
            ["requires_capture", TransactionStatus.PENDING],
        ])("maps Stripe PaymentIntent status '%s' to '%s'", async (stripeStatus, expected) => {
            mockRetrieve.mockResolvedValue({ id: "pi_1", status: stripeStatus, amount: 1500, currency: "usd" });

            const result = await stripeAdapter.verify("pi_1");

            expect(result.status).toBe(expected);
            expect(result.amount).toBe(15);
            expect(result.currency).toBe("usd");
        });
    });

    describe("handleWebhook", () => {
        it("verifies the signature and normalizes the event", () => {
            mockConstructEvent.mockReturnValue({
                type: "payment_intent.succeeded",
                data: { object: { id: "pi_1", status: "succeeded" } },
            });

            const event = stripeAdapter.handleWebhook("raw-body", "sig");

            expect(mockConstructEvent).toHaveBeenCalledWith("raw-body", "sig", expect.any(String));
            expect(event).toEqual({
                type: "payment_intent.succeeded",
                providerReference: "pi_1",
                status: TransactionStatus.SUCCEEDED,
                raw: expect.any(Object),
            });
        });

        it("propagates signature verification failures rather than swallowing them", () => {
            mockConstructEvent.mockImplementation(() => {
                throw new Error("Webhook signature verification failed");
            });

            expect(() => stripeAdapter.handleWebhook("raw-body", "bad-sig")).toThrow(
                "Webhook signature verification failed"
            );
        });
    });
});
