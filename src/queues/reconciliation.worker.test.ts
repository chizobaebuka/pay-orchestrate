import { TransactionStatus, ProviderName } from "../db/entities/transaction";

const mockFindOneBy = jest.fn();
const mockSave = jest.fn();
const mockGetRepository = jest.fn(() => ({ findOneBy: mockFindOneBy, save: mockSave }));

jest.mock("../db/data-source", () => ({
    AppDataSource: { getRepository: () => mockGetRepository() },
}));

const mockVerify = jest.fn();

jest.mock("../providers/registry", () => ({
    adapters: {
        stripe: { name: "stripe", verify: (...args: unknown[]) => mockVerify(...args) },
        paystack: { name: "paystack", verify: (...args: unknown[]) => mockVerify(...args) },
    },
}));

const mockBroadcast = jest.fn();
jest.mock("../realtime/socket", () => ({
    broadcastTransactionUpdate: (...args: unknown[]) => mockBroadcast(...args),
}));

// connection.ts reads REDIS_URL at import time to build BullMQ's connection options —
// mock it out so the worker module doesn't need a real Redis URl in the test environment.
jest.mock("./connection", () => ({ bullConnection: {} }));
jest.mock("bullmq", () => ({
    Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));

import { processReconciliationJob } from "./reconciliation.worker";

function baseTransaction(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: "txn-1",
        provider: ProviderName.STRIPE,
        providerReference: "pi_1",
        status: TransactionStatus.PENDING,
        amount: "20.00",
        currency: "USD",
        ...overrides,
    };
}

describe("processReconciliationJob — reconciliation state machine", () => {
    it("does nothing when the transaction can't be found (unknown/foreign providerReference)", async () => {
        mockFindOneBy.mockResolvedValue(null);

        await processReconciliationJob({
            provider: ProviderName.STRIPE,
            providerReference: "pi_unknown",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });

        expect(mockVerify).not.toHaveBeenCalled();
        expect(mockSave).not.toHaveBeenCalled();
        expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it("moves PENDING -> RECONCILED when the provider confirms success with matching amount and currency", async () => {
        const transaction = baseTransaction();
        mockFindOneBy.mockResolvedValue(transaction);
        mockVerify.mockResolvedValue({ status: TransactionStatus.SUCCEEDED, amount: 20, currency: "USD" });

        await processReconciliationJob({
            provider: ProviderName.STRIPE,
            providerReference: "pi_1",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });

        expect(transaction.status).toBe(TransactionStatus.RECONCILED);
        expect(mockSave).toHaveBeenCalledWith(transaction);
        expect(mockBroadcast).toHaveBeenCalledWith(transaction);
    });

    it("moves PENDING -> MISMATCHED when the provider-confirmed amount disagrees with the initiated amount", async () => {
        const transaction = baseTransaction({ amount: "999.99" }); // simulates a tampered/incorrect stored record
        mockFindOneBy.mockResolvedValue(transaction);
        mockVerify.mockResolvedValue({ status: TransactionStatus.SUCCEEDED, amount: 20, currency: "USD" });

        await processReconciliationJob({
            provider: ProviderName.STRIPE,
            providerReference: "pi_1",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });

        expect(transaction.status).toBe(TransactionStatus.MISMATCHED);
        expect(mockSave).toHaveBeenCalledWith(transaction);
    });

    it("moves PENDING -> MISMATCHED when the currency disagrees even if the amount matches", async () => {
        const transaction = baseTransaction({ currency: "USD" });
        mockFindOneBy.mockResolvedValue(transaction);
        mockVerify.mockResolvedValue({ status: TransactionStatus.SUCCEEDED, amount: 20, currency: "EUR" });

        await processReconciliationJob({
            provider: ProviderName.STRIPE,
            providerReference: "pi_1",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });

        expect(transaction.status).toBe(TransactionStatus.MISMATCHED);
    });

    it("tolerates sub-cent floating point differences without flagging a false mismatch", async () => {
        const transaction = baseTransaction({ amount: "20.00" });
        mockFindOneBy.mockResolvedValue(transaction);
        // 19.999999... rather than exactly 20 — should still count as matching
        mockVerify.mockResolvedValue({ status: TransactionStatus.SUCCEEDED, amount: 19.999999, currency: "USD" });

        await processReconciliationJob({
            provider: ProviderName.STRIPE,
            providerReference: "pi_1",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });

        expect(transaction.status).toBe(TransactionStatus.RECONCILED);
    });

    it("moves status to FAILED when the provider reports the payment failed, regardless of amount", async () => {
        const transaction = baseTransaction();
        mockFindOneBy.mockResolvedValue(transaction);
        mockVerify.mockResolvedValue({ status: TransactionStatus.FAILED, amount: 20, currency: "USD" });

        await processReconciliationJob({
            provider: ProviderName.STRIPE,
            providerReference: "pi_1",
            webhookStatus: TransactionStatus.FAILED,
        });

        expect(transaction.status).toBe(TransactionStatus.FAILED);
    });

    it("is case-insensitive when comparing currency codes", async () => {
        const transaction = baseTransaction({ currency: "usd" });
        mockFindOneBy.mockResolvedValue(transaction);
        mockVerify.mockResolvedValue({ status: TransactionStatus.SUCCEEDED, amount: 20, currency: "USD" });

        await processReconciliationJob({
            provider: ProviderName.STRIPE,
            providerReference: "pi_1",
            webhookStatus: TransactionStatus.SUCCEEDED,
        });

        expect(transaction.status).toBe(TransactionStatus.RECONCILED);
    });
});
