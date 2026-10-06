-- Phone becomes a login identifier for drivers: must be unique.
-- Existing rows are untouched; Postgres allows multiple NULLs under a
-- UNIQUE constraint, so students/admins/agents with no phone on file are
-- unaffected. If two existing rows share a non-null phone, this migration
-- will fail and those duplicates must be resolved by hand first.
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- Mirrors driver_card_credentials for admins: card UID + hashed terminal PIN,
-- used to provision the terminal's AD (admin) list.
CREATE TABLE "admin_card_credentials" (
    "id" TEXT NOT NULL,
    "admin_uid" VARCHAR(20) NOT NULL,
    "card_uid" VARCHAR(20) NOT NULL,
    "pin_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_card_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_card_credentials_admin_uid_key" ON "admin_card_credentials"("admin_uid");
CREATE UNIQUE INDEX "admin_card_credentials_card_uid_key" ON "admin_card_credentials"("card_uid");
CREATE INDEX "admin_card_credentials_admin_uid_idx" ON "admin_card_credentials"("admin_uid");
CREATE INDEX "admin_card_credentials_card_uid_idx" ON "admin_card_credentials"("card_uid");

ALTER TABLE "admin_card_credentials" ADD CONSTRAINT "admin_card_credentials_admin_uid_fkey"
  FOREIGN KEY ("admin_uid") REFERENCES "users"("matricNumber") ON DELETE CASCADE ON UPDATE CASCADE;
