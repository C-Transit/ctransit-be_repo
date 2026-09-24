-- AlterTable
ALTER TABLE "users" ADD COLUMN "bankCode" VARCHAR(20),
ADD COLUMN "accountName" VARCHAR(100),
ADD COLUMN "bankVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "driver_card_credentials" (
    "id" TEXT NOT NULL,
    "driver_uid" VARCHAR(20) NOT NULL,
    "card_uid" VARCHAR(20) NOT NULL,
    "pin_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_card_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_card_credentials_driver_uid_key" ON "driver_card_credentials"("driver_uid");

-- CreateIndex
CREATE UNIQUE INDEX "driver_card_credentials_card_uid_key" ON "driver_card_credentials"("card_uid");

-- CreateIndex
CREATE INDEX "driver_card_credentials_driver_uid_idx" ON "driver_card_credentials"("driver_uid");

-- CreateIndex
CREATE INDEX "driver_card_credentials_card_uid_idx" ON "driver_card_credentials"("card_uid");

-- AddForeignKey
ALTER TABLE "driver_card_credentials" ADD CONSTRAINT "driver_card_credentials_driver_uid_fkey" FOREIGN KEY ("driver_uid") REFERENCES "users"("matricNumber") ON DELETE CASCADE ON UPDATE CASCADE;
