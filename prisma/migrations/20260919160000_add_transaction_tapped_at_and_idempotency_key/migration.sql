-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "tapped_at" TIMESTAMPTZ(6);
ALTER TABLE "transactions" ADD COLUMN "idempotency_key" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "transactions_tapped_at_idx" ON "transactions"("tapped_at");

-- CreateIndex
CREATE INDEX "transactions_idempotency_key_idx" ON "transactions"("idempotency_key");
