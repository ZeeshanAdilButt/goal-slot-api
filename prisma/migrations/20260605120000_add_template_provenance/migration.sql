-- Template provenance on Goal: which curated template + which local goal ref
-- the row was imported from. Used by the "Sync from <curator>" flow.
ALTER TABLE "Goal" ADD COLUMN "templateId" TEXT;
ALTER TABLE "Goal" ADD COLUMN "templateGoalRef" TEXT;
CREATE INDEX "Goal_userId_templateId_idx" ON "Goal"("userId", "templateId");

-- Template provenance on Task: which curated template + a stable per-task
-- key (slug of the title at import time). Sync uses this to skip tasks
-- the user already has.
ALTER TABLE "Task" ADD COLUMN "templateId" TEXT;
ALTER TABLE "Task" ADD COLUMN "templateTaskKey" TEXT;
CREATE INDEX "Task_userId_templateId_templateTaskKey_idx" ON "Task"("userId", "templateId", "templateTaskKey");
