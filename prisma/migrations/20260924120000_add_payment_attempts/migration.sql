-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "providerReference" VARCHAR(100),
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_reference_key" ON "payment_attempts"("reference");
CREATE INDEX "payment_attempts_userId_createdAt_idx" ON "payment_attempts"("userId", "createdAt" DESC);
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts"("status");
CREATE INDEX "payment_attempts_providerReference_idx" ON "payment_attempts"("providerReference");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
