import { Router, raw } from "express";
import { ProviderName } from "../db/entities/transaction";
import { stripeAdapter } from "../providers/stripe.adapter";
import { paystackAdapter } from "../providers/paystack.adapter";
import { reconciliationQueue } from "../queues/reconciliation.queue";

const router = Router();

// express.raw() keeps the body as an unparsed Buffer, required for signature verification.
// Signature verification happens here, synchronously, on receipt — everything else
// (looking up the transaction, re-verifying with the provider, updating status) is
// deferred to the reconciliation worker so a slow DB/provider call can't block the
// webhook response, and so a provider's retried delivery just re-queues a job.
router.post("/stripe", raw({ type: "application/json" }), async (req, res) => {
    const signature = req.header("stripe-signature");

    if (!signature) {
        return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    try {
        const event = stripeAdapter.handleWebhook(req.body, signature);
        await reconciliationQueue.add("reconcile", {
            provider: ProviderName.STRIPE,
            providerReference: event.providerReference,
            webhookStatus: event.status,
        });
        res.json({ received: true });
    } catch (err) {
        console.error("Stripe webhook verification failed:", err);
        res.status(400).json({ error: "Invalid webhook signature" });
    }
});

router.post("/paystack", raw({ type: "application/json" }), async (req, res) => {
    const signature = req.header("x-paystack-signature");

    if (!signature) {
        return res.status(400).json({ error: "Missing x-paystack-signature header" });
    }

    try {
        const event = paystackAdapter.handleWebhook(req.body, signature);
        await reconciliationQueue.add("reconcile", {
            provider: ProviderName.PAYSTACK,
            providerReference: event.providerReference,
            webhookStatus: event.status,
        });
        res.json({ received: true });
    } catch (err) {
        console.error("Paystack webhook verification failed:", err);
        res.status(400).json({ error: "Invalid webhook signature" });
    }
});

export default router;
