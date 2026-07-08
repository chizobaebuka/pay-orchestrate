import { Request, Response, NextFunction } from "express";

jest.mock("../db/redis-client", () => ({
    redisClient: {
        set: jest.fn(),
        get: jest.fn(),
    },
}));

import { idempotencyMiddleware } from "./idempotency.middleware";
import { redisClient } from "../db/redis-client";

const mockedSet = redisClient.set as jest.Mock;
const mockedGet = redisClient.get as jest.Mock;

function createMockReqRes(headers: Record<string, string> = {}) {
    const req = {
        header: (name: string) => headers[name.toLowerCase()],
    } as unknown as Request;

    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const res = { status, json } as unknown as Response;

    const next = jest.fn() as unknown as NextFunction;

    return { req, res, next, status, json };
}

describe("idempotencyMiddleware", () => {
    it("rejects requests without an Idempotency-Key header", async () => {
        const { req, res, next, status, json } = createMockReqRes();

        await idempotencyMiddleware(req, res, next);

        expect(status).toHaveBeenCalledWith(400);
        expect(json).toHaveBeenCalledWith({ error: "Idempotency-Key header is required" });
        expect(next).not.toHaveBeenCalled();
    });

    it("proceeds and attaches the key to the request when it's new", async () => {
        mockedSet.mockResolvedValue("OK");
        const { req, res, next } = createMockReqRes({ "idempotency-key": "key-1" });

        await idempotencyMiddleware(req, res, next);

        expect(mockedSet).toHaveBeenCalledWith(
            "idempotency:key-1",
            "processing",
            "EX",
            expect.any(Number),
            "NX"
        );
        expect((req as any).idempotencyKey).toBe("key-1");
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("returns 409 when a concurrent duplicate request is still processing", async () => {
        mockedSet.mockResolvedValue(null);
        mockedGet.mockResolvedValue("processing");
        const { req, res, next, status, json } = createMockReqRes({ "idempotency-key": "key-2" });

        await idempotencyMiddleware(req, res, next);

        expect(status).toHaveBeenCalledWith(409);
        expect(json).toHaveBeenCalledWith({
            error: "A request with this idempotency key is already being processed",
        });
        expect(next).not.toHaveBeenCalled();
    });

    it("returns the original result for a completed duplicate request", async () => {
        mockedSet.mockResolvedValue(null);
        mockedGet.mockResolvedValue("txn-123");
        const { req, res, next, status, json } = createMockReqRes({ "idempotency-key": "key-3" });

        await idempotencyMiddleware(req, res, next);

        expect(status).toHaveBeenCalledWith(200);
        expect(json).toHaveBeenCalledWith({
            message: "Duplicate request — returning original result",
            transactionId: "txn-123",
        });
        expect(next).not.toHaveBeenCalled();
    });
});
