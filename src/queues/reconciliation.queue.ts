import { Queue } from "bullmq";
import { bullConnection } from "./connection";
import { ProviderName, TransactionStatus } from "../db/entities/transaction";

export interface ReconciliationJobData {
    provider: ProviderName;
    providerReference: string;
    webhookStatus: TransactionStatus;
}

export const reconciliationQueue = new Queue<ReconciliationJobData, void, string>("reconciliation", {
    connection: bullConnection,
});
