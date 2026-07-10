-- DropIndex
DROP INDEX "wallets_v_bank_name_key";

-- AlterTable
ALTER TABLE "wallets" ALTER COLUMN "v_account_number" DROP NOT NULL,
ALTER COLUMN "v_bank_name" DROP NOT NULL;
