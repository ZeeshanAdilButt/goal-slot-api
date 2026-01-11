/*
  Warnings:

  - The required column `seriesId` was added to the `ScheduleBlock` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
ALTER TABLE "ScheduleBlock" ADD COLUMN     "seriesId" TEXT;

UPDATE "ScheduleBlock" SET "seriesId" = "id" WHERE "seriesId" IS NULL;

ALTER TABLE "ScheduleBlock" ALTER COLUMN "seriesId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SharedAccess" ADD COLUMN     "isPublicLink" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ScheduleBlock_seriesId_idx" ON "ScheduleBlock"("seriesId");
