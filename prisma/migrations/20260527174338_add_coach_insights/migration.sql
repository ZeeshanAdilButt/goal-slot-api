-- CreateEnum
CREATE TYPE "CoachInsightKind" AS ENUM ('OBSERVATION', 'SUGGESTION', 'EXPERIMENT', 'MEDIA_PROMPT');

-- CreateEnum
CREATE TYPE "CoachInsightStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'DOING', 'DONE', 'DISMISSED', 'SAVED');

-- CreateEnum
CREATE TYPE "ReligiousContext" AS ENUM ('NONE', 'ISLAM', 'CHRISTIANITY', 'HINDUISM', 'BUDDHISM', 'JUDAISM', 'SECULAR', 'OTHER');

-- AlterTable
ALTER TABLE "HabitsProfile" ADD COLUMN     "religiousContext" "ReligiousContext" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "spiritualNotes" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "CoachInsight" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceConversationId" TEXT,
    "sourceMessageId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "kind" "CoachInsightKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "suggestedAction" TEXT,
    "mediaSlot" TEXT,
    "mediaTopic" TEXT,
    "status" "CoachInsightStatus" NOT NULL DEFAULT 'PROPOSED',
    "acceptedAt" TIMESTAMP(3),
    "startedDoingAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "savedAt" TIMESTAMP(3),
    "userNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachInsight_userId_status_idx" ON "CoachInsight"("userId", "status");

-- CreateIndex
CREATE INDEX "CoachInsight_userId_scopeKey_idx" ON "CoachInsight"("userId", "scopeKey");

-- AddForeignKey
ALTER TABLE "CoachInsight" ADD CONSTRAINT "CoachInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
