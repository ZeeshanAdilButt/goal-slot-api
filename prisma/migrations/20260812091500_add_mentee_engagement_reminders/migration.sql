-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SHARED_REPORT_UNVIEWED';
ALTER TYPE "NotificationType" ADD VALUE 'INSTRUCTION_ASSIGNED';

-- AlterTable
ALTER TABLE "SharedAccess" ADD COLUMN     "lastViewReminderAt" TIMESTAMP(3),
ADD COLUMN     "lastViewedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Instruction" (
    "id" TEXT NOT NULL,
    "assignerId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "endpoint" TEXT,
    "p256dh" TEXT,
    "auth" TEXT,
    "expoToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Instruction_assigneeId_status_idx" ON "Instruction"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "Instruction_assignerId_idx" ON "Instruction"("assignerId");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_userId_endpoint_key" ON "PushSubscription"("userId", "endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_userId_expoToken_key" ON "PushSubscription"("userId", "expoToken");

-- AddForeignKey
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_assignerId_fkey" FOREIGN KEY ("assignerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
