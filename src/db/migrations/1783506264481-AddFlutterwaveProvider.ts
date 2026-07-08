import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFlutterwaveProvider1783506264481 implements MigrationInterface {
    name = 'AddFlutterwaveProvider1783506264481'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."transactions_provider_enum" ADD VALUE 'flutterwave'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."transactions_provider_enum_old" AS ENUM('stripe', 'paystack')`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "provider" TYPE "public"."transactions_provider_enum_old" USING "provider"::"text"::"public"."transactions_provider_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."transactions_provider_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."transactions_provider_enum_old" RENAME TO "transactions_provider_enum"`);
    }

}
