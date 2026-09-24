-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "fare" DECIMAL(10,2),
ADD COLUMN "driver_share" DECIMAL(10,2),
ADD COLUMN "ctransit_share" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "driver_wallets" (
    "id" TEXT NOT NULL,
    "driver_uid" VARCHAR(20) NOT NULL,
    "balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_earnings" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_wallets" (
    "id" TEXT NOT NULL DEFAULT 'CTRANSIT_SYSTEM',
    "name" TEXT NOT NULL DEFAULT 'C-Transit Platform',
    "balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_revenue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_wallets_driver_uid_key" ON "driver_wallets"("driver_uid");

-- CreateIndex
CREATE INDEX "driver_wallets_driver_uid_idx" ON "driver_wallets"("driver_uid");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_driver_uid_fkey" FOREIGN KEY ("driver_uid") REFERENCES "users"("matricNumber") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_wallets" ADD CONSTRAINT "driver_wallets_driver_uid_fkey" FOREIGN KEY ("driver_uid") REFERENCES "users"("matricNumber") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints to prevent negative balances
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance" >= 0);
ALTER TABLE "driver_wallets" ADD CONSTRAINT "driver_wallets_balance_non_negative" CHECK ("balance" >= 0);
ALTER TABLE "system_wallets" ADD CONSTRAINT "system_wallets_balance_non_negative" CHECK ("balance" >= 0);
