-- CreateEnum
CREATE TYPE "PushSubscriptionKind" AS ENUM ('WEB', 'EXPO');

-- Normalize existing "kind" values before the cast below - an enum cast
-- fails outright on any value that isn't one of the enum's labels, and this
-- column was free-form text until now. A row written with different
-- casing/spelling (e.g. "expo", " EXPO", "Web") was previously accepted
-- silently and made permanently invisible to the Expo push channel's
-- `where: { kind: 'EXPO' }` query, with no error anywhere in the path -
-- this UPDATE is what fixes those rows, not just the cast below.
--
-- Disambiguate by column content: a case/whitespace-normalized match to
-- WEB or EXPO wins outright. Anything else falls back to whichever shape
-- the row's other columns actually have - an EXPO row always carries
-- expoToken and a WEB row never does - and defaults to WEB (the original
-- default in application code) when even that signal is absent.
UPDATE "PushSubscription"
SET "kind" = CASE
  WHEN upper(trim("kind")) IN ('WEB', 'EXPO') THEN upper(trim("kind"))
  WHEN "expoToken" IS NOT NULL THEN 'EXPO'
  ELSE 'WEB'
END;

-- AlterTable
ALTER TABLE "PushSubscription"
  ALTER COLUMN "kind" TYPE "PushSubscriptionKind" USING ("kind"::"PushSubscriptionKind");
