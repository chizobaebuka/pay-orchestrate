import crypto from "crypto";
import { TransactionStatus } from "../db/entities/transaction";

const originalFetch = global.fetch;
const originalEnv = {
    clientId: process.env.FW_TEST_CLIENT_ID,
    clientSecret: process.env.FW_TEST_CLIENT_SECRET,
    webhookHash: process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH,
};

beforeAll(() => {
    process.env.FW_TEST_CLIENT_ID = "test-client-id";
    process.env.FW_TEST_CLIENT_SECRET = "test-client-secret";
    process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH = "test-secret-hash";
});

afterAll(() => {
    process.env.FW_TEST_CLIENT_ID = originalEnv.clientId;
    process.env.FW_TEST_CLIENT_SECRET = originalEnv.clientSecret;
    process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH = originalEnv.webhookHash;
    global.fetch = originalFetch;
});

function mockFetchSequence(responses: Array<{ ok?: boolean; body: unknown }>) {
    const impl = jest.fn();
    responses.forEach((r) => impl.mockImplementationOnce(async () => ({ ok: r.ok ?? true, json: async () => r.body })));
    global.fetch = impl as any;
    return impl;
}

function sign(payload: string): string {
    return crypto.createHmac("sha256", "test-secret-hash").update(payload).digest("base64");
}

// Each test re-imports so the module-level OAuth token cache doesn't leak between tests.
async function loadAdapter() {
    jest.resetModules();
    const mod = await import("./flutterwave.adapter");
    return mod.flutterwaveAdapter;
}

describe("flutterwaveAdapter", () => {
    describe("initiate", () => {
        it("creates a customer then a virtual account, in major currency units", async () => {
            const fetchMock = mockFetchSequence([
                { body: { access_token: "token-1", expires_in: 600 } }, // OAuth token
                { body: { status: "success", data: { id: "cus_1" } } }, // create customer
                {
                    body: {
                        status: "success",
                        data: { account_number: "1234567890", account_bank_name: "Mock Bank" },
                    },
                }, // create virtual account
            ]);

            const adapter = await loadAdapter();
            const result = await adapter.initiate({ amount: 2500, currency: "ngn", customerEmail: "a@b.com" });

            expect(result.status).toBe(TransactionStatus.PENDING);
            expect(result.paymentInstructions).toContain("1234567890");
            expect(result.paymentInstructions).toContain("Mock Bank");
            expect(typeof result.providerReference).toBe("string");

            // The virtual-accounts call (3rd fetch) must carry the amount un-multiplied —
            // Flutterwave v4 uses major units directly, unlike Stripe/Paystack.
            const vaCallBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
            expect(vaCallBody.amount).toBe(2500);
            expect(vaCallBody.currency).toBe("NGN");
        });

        it("throws when no customerEmail is provided", async () => {
            const adapter = await loadAdapter();
            await expect(adapter.initiate({ amount: 10, currency: "ngn" })).rejects.toThrow(
                "customerEmail is required"
            );
        });

        it("throws with Flutterwave's message when a request fails", async () => {
            mockFetchSequence([
                { body: { access_token: "token-1", expires_in: 600 } },
                { ok: false, body: { status: "error", message: "invalid email" } },
            ]);

            const adapter = await loadAdapter();
            await expect(adapter.initiate({ amount: 10, currency: "ngn", customerEmail: "bad" })).rejects.toThrow(
                "invalid email"
            );
        });
    });

    describe("verify", () => {
        it("returns PENDING with placeholder amount/currency when no charge exists yet", async () => {
            mockFetchSequence([
                { body: { access_token: "token-1", expires_in: 600 } },
                { body: { status: "success", data: [] } },
            ]);

            const adapter = await loadAdapter();
            const result = await adapter.verify("ref-1");

            expect(result.status).toBe(TransactionStatus.PENDING);
        });

        it.each([
            ["succeeded", TransactionStatus.SUCCEEDED],
            ["failed", TransactionStatus.FAILED],
            ["pending", TransactionStatus.PENDING],
        ])("maps charge status '%s' to '%s'", async (chargeStatus, expected) => {
            mockFetchSequence([
                { body: { access_token: "token-1", expires_in: 600 } },
                {
                    body: {
                        status: "success",
                        data: [{ reference: "ref-1", status: chargeStatus, amount: 2500, currency: "NGN" }],
                    },
                },
            ]);

            const adapter = await loadAdapter();
            const result = await adapter.verify("ref-1");

            expect(result.status).toBe(expected);
            expect(result.amount).toBe(2500);
            expect(result.currency).toBe("NGN");
        });
    });

    describe("handleWebhook", () => {
        it("accepts a correctly signed payload", async () => {
            const adapter = await loadAdapter();
            const payload = JSON.stringify({
                type: "charge.completed",
                data: { reference: "ref-1", status: "succeeded" },
            });

            const event = adapter.handleWebhook(payload, sign(payload));

            expect(event).toEqual({
                type: "charge.completed",
                providerReference: "ref-1",
                status: TransactionStatus.SUCCEEDED,
                raw: expect.any(Object),
            });
        });

        it("rejects a tampered payload", async () => {
            const adapter = await loadAdapter();
            const originalPayload = JSON.stringify({
                type: "charge.completed",
                data: { reference: "ref-1", status: "succeeded" },
            });
            const signature = sign(originalPayload);
            const tamperedPayload = JSON.stringify({
                type: "charge.completed",
                data: { reference: "ref-1", status: "succeeded", amount: 999999 },
            });

            expect(() => adapter.handleWebhook(tamperedPayload, signature)).toThrow(
                "Invalid Flutterwave webhook signature"
            );
        });

        it("rejects a garbage signature", async () => {
            const adapter = await loadAdapter();
            const payload = JSON.stringify({ type: "charge.completed", data: { reference: "ref-1", status: "succeeded" } });

            expect(() => adapter.handleWebhook(payload, "not-a-real-signature")).toThrow(
                "Invalid Flutterwave webhook signature"
            );
        });
    });
});
