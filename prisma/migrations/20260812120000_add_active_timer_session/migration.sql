-- Server-side "active timer session".
--
-- A TimeEntry is only written when a timer STOPS, so a running timer used to
-- exist only in each client's local store: start tracking on the web app and
-- the mobile app had no idea anything was running. This table is the shared
-- truth.
--
-- Generated offline with `prisma migrate diff --from-schema <previous>
-- --to-schema prisma/schema.prisma --script` — no database was contacted.
-- scripts/deploy.ps1 applies it on the VPS via `prisma migrate deploy`.
--
-- Purely additive: one new enum, one new table, and foreign keys pointing at
-- existing tables. No existing column is touched, so a rollback is a plain
-- DROP and older API instances are unaffected while the deploy rolls.

-- CreateEnum
CREATE TYPE "ActiveTimerStatus" AS ENUM ('RUNNING', 'PAUSED');

-- CreateTable
--
-- `accumulatedMs` holds running time from completed segments only, and
-- `segmentStartedAt` marks the open one. Elapsed time is derived from those
-- two on read rather than stored, so it can never go stale between writes.
CREATE TABLE "ActiveTimerSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ActiveTimerStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "segmentStartedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "accumulatedMs" INTEGER NOT NULL DEFAULT 0,
    "taskName" TEXT,
    "notes" TEXT,
    "goalId" TEXT,
    "taskId" TEXT,
    "scheduleBlockId" TEXT,
    "lastClient" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveTimerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- One active session per user, enforced here rather than by a read-then-write
-- in the service. Two devices racing on start resolve to one winner and one
-- unique violation (which the API turns into a 409), never two rows.
CREATE UNIQUE INDEX "ActiveTimerSession_userId_key" ON "ActiveTimerSession"("userId");

-- CreateIndex
CREATE INDEX "ActiveTimerSession_goalId_idx" ON "ActiveTimerSession"("goalId");

-- CreateIndex
CREATE INDEX "ActiveTimerSession_taskId_idx" ON "ActiveTimerSession"("taskId");

-- CreateIndex
CREATE INDEX "ActiveTimerSession_scheduleBlockId_idx" ON "ActiveTimerSession"("scheduleBlockId");

-- AddForeignKey
ALTER TABLE "ActiveTimerSession" ADD CONSTRAINT "ActiveTimerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Attribution detaches instead of cascading, matching TimeEntry: deleting a
-- goal must not silently kill the timer the user is running right now.
ALTER TABLE "ActiveTimerSession" ADD CONSTRAINT "ActiveTimerSession_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveTimerSession" ADD CONSTRAINT "ActiveTimerSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveTimerSession" ADD CONSTRAINT "ActiveTimerSession_scheduleBlockId_fkey" FOREIGN KEY ("scheduleBlockId") REFERENCES "ScheduleBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
