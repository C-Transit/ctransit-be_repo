-- AlterTable
ALTER TABLE "terminals" ADD COLUMN "location" VARCHAR(10);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "location" VARCHAR(10);
ALTER TABLE "transactions" ADD COLUMN "card_uid" VARCHAR(20);

-- AlterTable
ALTER TABLE "registration_otps" ADD COLUMN "agent_uid" VARCHAR(36);

-- CreateTable
CREATE TABLE "fare_configs" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "location_name" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "updated_by" VARCHAR(50),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fare_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "terminals_location_idx" ON "terminals"("location");

-- CreateIndex
CREATE INDEX "transactions_location_idx" ON "transactions"("location");

-- CreateIndex
CREATE INDEX "transactions_card_uid_idx" ON "transactions"("card_uid");

-- CreateIndex
CREATE INDEX "registration_otps_agent_uid_idx" ON "registration_otps"("agent_uid");

-- CreateIndex
CREATE UNIQUE INDEX "fare_configs_code_key" ON "fare_configs"("code");

-- Seed initial FareConfig records safely
INSERT INTO "fare_configs" ("id", "code", "location_name", "amount", "updated_by", "created_at", "updated_at")
VALUES
    ('fare-loc-a-seed', 'A', 'Bus Park', 150.00, 'SYSTEM_INIT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fare-loc-b-seed', 'B', 'Department', 200.00, 'SYSTEM_INIT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fare-loc-c-seed', 'C', 'Hostel/Clinic', 300.00, 'SYSTEM_INIT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
