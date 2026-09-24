-- AlterTable
ALTER TABLE "driver_withdrawals" ADD COLUMN "fee" DECIMAL(10,2);
ALTER TABLE "driver_withdrawals" ADD COLUMN "net_amount" DECIMAL(10,2);
ALTER TABLE "driver_withdrawals" ADD COLUMN "kora_reference" VARCHAR(100);
ALTER TABLE "driver_withdrawals" ADD COLUMN "kora_fee" DECIMAL(10,2);
ALTER TABLE "driver_withdrawals" ADD COLUMN "failure_reason" VARCHAR(255);

-- CreateIndex
CREATE INDEX "driver_withdrawals_reference_idx" ON "driver_withdrawals"("reference");
CREATE INDEX "driver_withdrawals_kora_reference_idx" ON "driver_withdrawals"("kora_reference");
