-- CreateEnum
CREATE TYPE "TimeEntrySource" AS ENUM ('COMPLETION', 'TRACKER');

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN "source" "TimeEntrySource" NOT NULL DEFAULT 'TRACKER';
