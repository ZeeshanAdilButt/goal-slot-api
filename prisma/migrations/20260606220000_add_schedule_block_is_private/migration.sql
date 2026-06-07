-- Mentees can mark individual schedule blocks as private so that a
-- mentor (or anyone they have shared their workspace with) does not see
-- the block in the shared schedule view, and does not see the time
-- entries linked to it in the shared time-tracking view.
--
-- Default is FALSE so existing rows stay visible after the migration;
-- the user opts in per-block when they want privacy.

ALTER TABLE "ScheduleBlock"
ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false;
