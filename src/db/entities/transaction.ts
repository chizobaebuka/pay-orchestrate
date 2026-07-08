import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

export enum TransactionStatus {
    PENDING = "pending",
    PROCESSING = "processing",
    SUCCEEDED = "succeeded",
    FAILED = "failed",
    RECONCILED = "reconciled",
    MISMATCHED = "mismatched",
}

export enum ProviderName {
    STRIPE = "stripe",
    PAYSTACK = "paystack",
}

@Entity("transactions")
export class Transaction {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    idempotencyKey!: string;

    @Column({ type: "enum", enum: ProviderName })
    provider!: ProviderName;

    @Column({ nullable: true })
    providerReference!: string; // the ID Stripe/Paystack gives back

    @Column({ type: "enum", enum: TransactionStatus, default: TransactionStatus.PENDING })
    status!: TransactionStatus;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    amount!: string;

    @Column({ default: "NGN" })
    currency!: string;

    @Column({ nullable: true })
    customerEmail!: string;

    @Column({ type: "jsonb", nullable: true })
    metadata!: Record<string, unknown>;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}