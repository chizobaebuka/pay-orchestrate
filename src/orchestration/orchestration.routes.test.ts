import express from "express";
import request from "supertest";
import { TransactionStatus } from "../db/entities/transaction";

jest.mock("../db/redis-client", () => ({
    redisClient: { set: jest.fn(), get: jest.fn(), del: jest.fn() },
}));

const mockCreate = jest.fn();
const mockSave = jest.fn();
const mockFind = jest.fn();

jest.mock("../db/data-source", () => ({
    AppDataSource: {
        getRepository: () => ({
            create: (...args: unknown[]) => mockCreate(...args),
            save: (...args: unknown[]) => mockSave(...args),
            find: (...args: unknown[]) => mockFind(...args),
        }),
    },
}));

const mockInitiate = jest.fn();

jest.mock("../providers/registry", () => ({
    adapters: {
        stripe: { name: "stripe", initiate: (...args: unknown[]) => mockInitiate(...args) },
        paystack: { name: "paystack", initiate: (...args: unknown[]) => mockInitiate(...args) },
    },
}));

const mockBroadcast = jest.fn();
jest.mock("../realtime/socket", () => ({
    broadcastTransactionUpdate: (...args: unknown[]) => mockBroadcast(...args),
}));

import orchestrationRoutes from "./orchestration.routes";
import { redisClient } from "../db/redis-client";

const mockedRedisSet = redisClient.set as jest.Mock;
const mockedRedisGet = redisClient.get as jest.Mock;
const mockedRedisDel = redisClient.del as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api", orchestrationRoutes);

describe("POST /api/payments", () => {
    beforeEach(() => {
        mockedRedisSet.mockResolvedValue("OK"); // fresh idempotency key by default
    });

    it("creates a transaction, persists it, and broadcasts the update", async () => {
        mockInitiate.mockResolvedValue({ providerReference: "pi_1", status: TransactionStatus.PENDING });
        mockCreate.mockImplementation((data) => data);
        // TypeORM's save() mutates the passed-in entity in place (populating generated
        // columns like id) rather than requiring the caller to use its return value —
        // mirror that here since orchestration.routes.ts relies on it.
        mockSave.mockImplementation(async (txn) => {
            txn.id = "txn-1";
            return txn;
        });

        const res = await request(app)
            .post("/api/payments")
            .set("Idempotency-Key", "key-1")
            .send({ amount: 20, currency: "USD", customerEmail: "a@b.com", provider: "stripe" });

        expect(res.status).toBe(202);
        expect(res.body).toEqual(
            expect.objectContaining({
                transactionId: "txn-1",
                providerReference: "pi_1",
                status: TransactionStatus.PENDING,
            })
        );
        expect(mockInitiate).toHaveBeenCalledWith(
            expect.objectContaining({ amount: 20, currency: "USD", customerEmail: "a@b.com" })
        );
        expect(mockBroadcast).toHaveBeenCalledTimes(1);
        expect(mockedRedisSet).toHaveBeenCalledWith("idempotency:key-1", "txn-1", "EX", expect.any(Number));
    });

    it("rejects a request missing amount/currency and releases the idempotency key", async () => {
        const res = await request(app).post("/api/payments").set("Idempotency-Key", "key-2").send({ currency: "USD" });

        expect(res.status).toBe(400);
        expect(mockedRedisDel).toHaveBeenCalledWith("idempotency:key-2");
        expect(mockInitiate).not.toHaveBeenCalled();
    });

    it("rejects an unsupported provider and releases the idempotency key", async () => {
        const res = await request(app)
            .post("/api/payments")
            .set("Idempotency-Key", "key-3")
            .send({ amount: 10, currency: "USD", provider: "dogecoin" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Unsupported provider/);
        expect(mockedRedisDel).toHaveBeenCalledWith("idempotency:key-3");
        expect(mockInitiate).not.toHaveBeenCalled();
    });

    it("returns 502 and releases the idempotency key when the provider call fails", async () => {
        mockInitiate.mockRejectedValue(new Error("network error"));

        const res = await request(app).post("/api/payments").set("Idempotency-Key", "key-4").send({ amount: 10, currency: "USD" });

        expect(res.status).toBe(502);
        expect(mockedRedisDel).toHaveBeenCalledWith("idempotency:key-4");
    });

    it("returns 400 when the Idempotency-Key header is missing entirely", async () => {
        const res = await request(app).post("/api/payments").send({ amount: 10, currency: "USD" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Idempotency-Key header is required/);
        expect(mockInitiate).not.toHaveBeenCalled();
    });

    it("short-circuits a duplicate request that already completed, without re-charging", async () => {
        mockedRedisSet.mockResolvedValue(null);
        mockedRedisGet.mockResolvedValue("txn-existing");

        const res = await request(app).post("/api/payments").set("Idempotency-Key", "key-5").send({ amount: 10, currency: "USD" });

        expect(res.status).toBe(200);
        expect(res.body.transactionId).toBe("txn-existing");
        expect(mockInitiate).not.toHaveBeenCalled();
    });
});

describe("GET /api/transactions", () => {
    it("returns the most recent transactions, newest first", async () => {
        mockFind.mockResolvedValue([{ id: "txn-1" }, { id: "txn-2" }]);

        const res = await request(app).get("/api/transactions");

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ id: "txn-1" }, { id: "txn-2" }]);
        expect(mockFind).toHaveBeenCalledWith({ order: { updatedAt: "DESC" }, take: 20 });
    });
});
