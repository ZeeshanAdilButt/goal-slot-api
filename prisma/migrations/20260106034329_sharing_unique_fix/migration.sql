/*
  Warnings:

  - A unique constraint covering the columns `[ownerId,inviteEmail]` on the table `SharedAccess` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "SharedAccess" ALTER COLUMN "sharedWithId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SharedAccess_ownerId_inviteEmail_key" ON "SharedAccess"("ownerId", "inviteEmail");
