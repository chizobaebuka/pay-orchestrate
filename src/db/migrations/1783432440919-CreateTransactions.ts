import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTransactions1783432440919 implements MigrationInterface {
    name = 'CreateTransactions1783432440919'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."transactions_provider_enum" AS ENUM('stripe', 'paystack')`);
        await queryRunner.query(`CREATE TYPE "public"."transactions_status_enum" AS ENUM('pending', 'processing', 'succeeded', 'failed', 'reconciled', 'mismatched')`);
        await queryRunner.query(`CREATE TABLE "transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "idempotencyKey" character varying NOT NULL, "provider" "public"."transactions_provider_enum" NOT NULL, "providerReference" character varying, "status" "public"."transactions_status_enum" NOT NULL DEFAULT 'pending', "amount" numeric(12,2) NOT NULL, "currency" character varying NOT NULL DEFAULT 'NGN', "customerEmail" character varying, "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_86238dd0ae2d79be941104a5842" UNIQUE ("idempotencyKey"), CONSTRAINT "PK_a219afd8dd77ed80f5a862f1db9" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "transactions"`);
        await queryRunner.query(`DROP TYPE "public"."transactions_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."transactions_provider_enum"`);
    }

}
