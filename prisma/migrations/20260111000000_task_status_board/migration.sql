-- Migrate TaskStatus enum and existing rows to new kanban states
-- Old values: PENDING, IN_PROGRESS, COMPLETED
-- New values: BACKLOG, TODO, DOING, DONE

BEGIN;

-- 1) Create the new enum
CREATE TYPE "TaskStatus_new" AS ENUM ('BACKLOG', 'TODO', 'DOING', 'DONE');

-- 2) Drop default before type switch
ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;

-- 3) Convert data and column type
ALTER TABLE "Task" ALTER COLUMN "status" TYPE "TaskStatus_new" USING (
  CASE "status"
    WHEN 'PENDING' THEN 'BACKLOG'::"TaskStatus_new"
    WHEN 'IN_PROGRESS' THEN 'DOING'::"TaskStatus_new"
    WHEN 'COMPLETED' THEN 'DONE'::"TaskStatus_new"
    ELSE 'BACKLOG'::"TaskStatus_new"
  END
);

-- 4) Drop old enum and rename the new one
DROP TYPE "TaskStatus";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";

-- 5) Re-apply default
ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'BACKLOG';

COMMIT;
