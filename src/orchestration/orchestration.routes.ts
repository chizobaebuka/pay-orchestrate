import { Router } from "express";
import { idempotencyMiddleware } from "./idempotency.middleware";
import { AppDataSource } from "../db/data-source";
import { Transaction, ProviderName } from "../db/entities/transaction";
import { redisClient } from "../db/redis-client";
import { adapters } from "../providers/registry";
import { broadcastTransactionUpdate } from "../realtime/socket";

const router = Router();
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // matches idempotency.middleware.ts

router.post("/payments", idempotencyMiddleware, async (req, res) => {
    const idempotencyKey = (req as any).idempotencyKey;
    const { amount, currency, customerEmail, metadata, provider = ProviderName.STRIPE } = req.body;

    if (typeof amount !== "number" || !currency) {
        await redisClient.del(`idempotency:${idempotencyKey}`);
        return res.status(400).json({ error: "amount (number) and currency are required" });
    }

    const adapter = adapters[provider as ProviderName];

    if (!adapter) {
        await redisClient.del(`idempotency:${idempotencyKey}`);
        return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    const transactionRepo = AppDataSource.getRepository(Transaction);

    try {
        const result = await adapter.initiate({ amount, currency, customerEmail, metadata });

        const transaction = transactionRepo.create({
            idempotencyKey,
            provider: adapter.name,
            providerReference: result.providerReference,
            status: result.status,
            amount: amount.toFixed(2),
            currency,
            customerEmail,
            metadata,
        });

        await transactionRepo.save(transaction);
        broadcastTransactionUpdate(transaction);

        // Replace the "processing" placeholder with the real transaction id so
        // retried requests with the same key return the original result.
        await redisClient.set(`idempotency:${idempotencyKey}`, transaction.id, "EX", IDEMPOTENCY_TTL_SECONDS);

        res.status(202).json({
            message: "Payment accepted for processing",
            transactionId: transaction.id,
            providerReference: transaction.providerReference,
            status: transaction.status,
            redirectUrl: result.redirectUrl,
            paymentInstructions: result.paymentInstructions,
        });
    } catch (err) {
        await redisClient.del(`idempotency:${idempotencyKey}`);
        console.error("Payment initiation failed:", err);
        res.status(502).json({ error: "Failed to initiate payment with provider" });
    }
});

router.get("/transactions", async (_req, res) => {
    const transactionRepo = AppDataSource.getRepository(Transaction);
    const transactions = await transactionRepo.find({ order: { updatedAt: "DESC" }, take: 20 });
    res.json(transactions);
});

export default router;
