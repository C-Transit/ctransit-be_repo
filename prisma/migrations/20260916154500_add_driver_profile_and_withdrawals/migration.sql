-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20),
ADD COLUMN "vehicleType" VARCHAR(50),
ADD COLUMN "vehiclePlate" VARCHAR(50),
ADD COLUMN "bankName" VARCHAR(100),
ADD COLUMN "accountNumber" VARCHAR(50);

-- CreateTable
CREATE TABLE "driver_withdrawals" (
    "id" TEXT NOT NULL,
    "driver_uid" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "bank_name" VARCHAR(100) NOT NULL,
    "account_number" VARCHAR(50) NOT NULL,
    "account_name" VARCHAR(100) NOT NULL,
    "remarks" VARCHAR(255),
    "reference" VARCHAR(64) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_withdrawals_reference_key" ON "driver_withdrawals"("reference");

-- CreateIndex
CREATE INDEX "driver_withdrawals_driver_uid_created_at_idx" ON "driver_withdrawals"("driver_uid", "created_at" DESC);

-- CreateIndex
CREATE INDEX "driver_withdrawals_status_idx" ON "driver_withdrawals"("status");

-- AddForeignKey
ALTER TABLE "driver_withdrawals" ADD CONSTRAINT "driver_withdrawals_driver_uid_fkey" FOREIGN KEY ("driver_uid") REFERENCES "users"("matricNumber") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "driver_withdrawals" ADD CONSTRAINT "driver_withdrawals_amount_positive" CHECK ("amount" > 0);
