/*
  Warnings:

  - A unique constraint covering the columns `[v_account_number]` on the table `wallets` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[v_bank_name]` on the table `wallets` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `v_account_number` to the `wallets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `v_bank_name` to the `wallets` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "v_account_number" VARCHAR(20) NOT NULL,
ADD COLUMN     "v_bank_name" VARCHAR(50) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "wallets_v_account_number_key" ON "wallets"("v_account_number");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_v_bank_name_key" ON "wallets"("v_bank_name");
