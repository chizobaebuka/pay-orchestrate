import { Request, Response, NextFunction } from "express";
import { redisClient } from "../db/redis-client";

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    const idempotencyKey = req.header("Idempotency-Key");

    if (!idempotencyKey) {
        return res.status(400).json({ error: "Idempotency-Key header is required" });
    }

    const redisKey = `idempotency:${idempotencyKey}`;

    // SET ... NX EX — atomic "set if not exists" with expiry.
    // Returns null if the key already existed (duplicate request).
    // "set this key only if it doesn't already exist, and expire it after N seconds"
    const result = await redisClient.set(redisKey, "processing", "EX", IDEMPOTENCY_TTL_SECONDS, "NX");

    if (result === null) {
        // Key already exists — check what state it's in
        const existingValue = await redisClient.get(redisKey);

        if (existingValue === "processing") {
            return res.status(409).json({
                error: "A request with this idempotency key is already being processed",
            });
        }

        // If we stored a transaction id after completion, return the original result
        return res.status(200).json({
            message: "Duplicate request — returning original result",
            transactionId: existingValue,
        });
    }

    // Attach the key to the request so downstream handlers can update it after processing
    (req as any).idempotencyKey = idempotencyKey;
    next();
}