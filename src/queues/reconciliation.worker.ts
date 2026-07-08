import { Worker } from "bullmq";
import { bullConnection } from "./connection";
import { AppDataSource } from "../db/data-source";
import { Transaction, TransactionStatus } from "../db/entities/transaction";
import { adapters } from "../providers/registry";
import { ReconciliationJobData } from "./reconciliation.queue";
import { broadcastTransactionUpdate } from "../realtime/socket";

const AMOUNT_TOLERANCE = 0.01;

// Exported standalone so the state-machine logic can be unit tested without a real
// Redis/BullMQ connection — startReconciliationWorker() just wires this into a Worker.
export async function processReconciliationJob(data: ReconciliationJobData): Promise<void> {
    const { provider, providerReference } = data;
    const transactionRepo = AppDataSource.getRepository(Transaction);
    const transaction = await transactionRepo.findOneBy({ providerReference });

    if (!transaction) {
        console.warn(`Reconciliation job for unknown transaction: ${providerReference}`);
        return;
    }

    // Re-verify against the provider directly rather than trusting the webhook
    // payload alone — this is what catches a tampered/incorrect initiated amount.
    const verified = await adapters[provider].verify(providerReference);

    const initiatedAmount = Number(transaction.amount);
    const amountMatches = Math.abs(verified.amount - initiatedAmount) < AMOUNT_TOLERANCE;
    const currencyMatches = verified.currency.toLowerCase() === transaction.currency.toLowerCase();

    if (verified.status === TransactionStatus.SUCCEEDED) {
        transaction.status =
            amountMatches && currencyMatches ? TransactionStatus.RECONCILED : TransactionStatus.MISMATCHED;
    } else {
        transaction.status = verified.status;
    }

    await transactionRepo.save(transaction);
    broadcastTransactionUpdate(transaction);

    if (transaction.status === TransactionStatus.MISMATCHED) {
        console.error(
            `Reconciliation mismatch for ${providerReference}: initiated ${initiatedAmount} ${transaction.currency}, ` +
                `provider confirmed ${verified.amount} ${verified.currency}`
        );
    }
}

export function startReconciliationWorker(): Worker<ReconciliationJobData> {
    const worker = new Worker<ReconciliationJobData>(
        "reconciliation",
        (job) => processReconciliationJob(job.data),
        { connection: bullConnection }
    );

    worker.on("failed", (job, err) => {
        console.error(`Reconciliation job ${job?.id} failed:`, err);
    });

    return worker;
}
