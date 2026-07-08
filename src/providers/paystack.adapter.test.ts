import crypto from "crypto";
import { TransactionStatus } from "../db/entities/transaction";
import { paystackAdapter } from "./paystack.adapter";

const originalFetch = global.fetch;
const originalSecret = process.env.PAYSTACK_TEST_SECRET;

beforeAll(() => {
    process.env.PAYSTACK_TEST_SECRET = "test-secret";
});

afterAll(() => {
    process.env.PAYSTACK_TEST_SECRET = originalSecret;
    global.fetch = originalFetch;
});

function mockFetchOnce(body: unknown, ok = true) {
    global.fetch = jest.fn().mockResolvedValue({ ok, json: async () => body }) as any;
}

function sign(payload: string): string {
    return crypto.createHmac("sha512", process.env.PAYSTACK_TEST_SECRET as string).update(payload).digest("hex");
}

describe("paystackAdapter", () => {
    describe("initiate", () => {
        it("initializes a transaction in kobo/cents and surfaces the hosted checkout redirectUrl", async () => {
            mockFetchOnce({
                status: true,
                data: { reference: "ref_1", authorization_url: "https://checkout.paystack.com/xyz" },
            });

            const result = await paystackAdapter.initiate({ amount: 10, currency: "ngn", customerEmail: "a@b.com" });

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/transaction/initialize"),
                expect.objectContaining({ method: "POST" })
            );
            const [, options] = (global.fetch as jest.Mock).mock.calls[0];
            expect(JSON.parse(options.body)).toEqual(
                expect.objectContaining({ email: "a@b.com", amount: 1000, currency: "NGN" })
            );
            expect(result).toEqual({
                providerReference: "ref_1",
                status: TransactionStatus.PENDING,
                redirectUrl: "https://checkout.paystack.com/xyz",
                raw: expect.any(Object),
            });
        });

        it("throws with Paystack's error message when the API rejects the request", async () => {
            mockFetchOnce({ status: false, message: "email address is required" }, true);

            await expect(paystackAdapter.initiate({ amount: 10, currency: "ngn" })).rejects.toThrow(
                "email address is required"
            );
        });
    });

    describe("verify", () => {
        it.each([
            ["success", TransactionStatus.SUCCEEDED],
            ["failed", TransactionStatus.FAILED],
            ["abandoned", TransactionStatus.FAILED],
            ["pending", TransactionStatus.PENDING],
        ])("maps Paystack status '%s' to '%s'", async (paystackStatus, expected) => {
            mockFetchOnce({
                status: true,
                data: { reference: "ref_1", status: paystackStatus, amount: 5000, currency: "NGN" },
            });

            const result = await paystackAdapter.verify("ref_1");

            expect(result.status).toBe(expected);
            expect(result.amount).toBe(50);
        });
    });

    describe("handleWebhook", () => {
        it("accepts a correctly signed payload", () => {
            const payload = JSON.stringify({ event: "charge.success", data: { reference: "ref_1", status: "success" } });

            const event = paystackAdapter.handleWebhook(payload, sign(payload));

            expect(event).toEqual({
                type: "charge.success",
                providerReference: "ref_1",
                status: TransactionStatus.SUCCEEDED,
                raw: expect.any(Object),
            });
        });

        it("rejects a payload that was tampered with after signing", () => {
            const originalPayload = JSON.stringify({ event: "charge.success", data: { reference: "ref_1", status: "success" } });
            const signature = sign(originalPayload);
            const tamperedPayload = JSON.stringify({
                event: "charge.success",
                data: { reference: "ref_1", status: "success", amount: 999999 },
            });

            expect(() => paystackAdapter.handleWebhook(tamperedPayload, signature)).toThrow(
                "Invalid Paystack webhook signature"
            );
        });

        it("rejects a garbage/forged signature", () => {
            const payload = JSON.stringify({ event: "charge.success", data: { reference: "ref_1", status: "success" } });

            expect(() => paystackAdapter.handleWebhook(payload, "not-a-real-signature")).toThrow(
                "Invalid Paystack webhook signature"
            );
        });
    });
});
