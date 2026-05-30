-- Add Gemini and OpenRouter to the CoachProvider enum so the BYOK
-- store and downstream LLM factory can pick them up. Postgres allows
-- ALTER TYPE ... ADD VALUE in a transaction since 12.
ALTER TYPE "CoachProvider" ADD VALUE IF NOT EXISTS 'GEMINI';
ALTER TYPE "CoachProvider" ADD VALUE IF NOT EXISTS 'OPENROUTER';

-- Per-user daily message counter for the shared-fallback path
-- (users with no BYOK row get a small allowance of Gemini Flash
-- calls from the operator's shared key). One row per user per day;
-- the day column is a date so the unique constraint actually scopes
-- to a calendar day rather than a timestamp instant.
CREATE TABLE IF NOT EXISTS "SharedCoachUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SharedCoachUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SharedCoachUsage_userId_day_key"
    ON "SharedCoachUsage"("userId", "day");

CREATE INDEX IF NOT EXISTS "SharedCoachUsage_userId_idx"
    ON "SharedCoachUsage"("userId");

ALTER TABLE "SharedCoachUsage"
    ADD CONSTRAINT "SharedCoachUsage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
