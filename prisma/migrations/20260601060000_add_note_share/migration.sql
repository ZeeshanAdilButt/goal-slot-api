-- Add a public share token to Note. NULL means link-sharing is off;
-- a value means /public/notes/:token returns this note read-only with
-- no auth required. Rotated by toggling off then back on.
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "publicShareToken" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Note_publicShareToken_key"
    ON "Note"("publicShareToken");

-- Per-recipient note share. One row per (note, email) pair. The
-- recipientUserId column links to a User once the email matches a
-- registered account; it stays NULL for pending invites to users
-- who haven't signed up yet (the recipient's first /notes/shared-with-me
-- request resolves those by matching their lowercased email).
CREATE TABLE IF NOT EXISTS "NoteShare" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "permission" TEXT NOT NULL DEFAULT 'VIEW',
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NoteShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NoteShare_noteId_recipientEmail_key"
    ON "NoteShare"("noteId", "recipientEmail");

CREATE INDEX IF NOT EXISTS "NoteShare_recipientUserId_idx"
    ON "NoteShare"("recipientUserId");

CREATE INDEX IF NOT EXISTS "NoteShare_recipientEmail_idx"
    ON "NoteShare"("recipientEmail");

CREATE INDEX IF NOT EXISTS "NoteShare_ownerId_idx"
    ON "NoteShare"("ownerId");

ALTER TABLE "NoteShare"
    ADD CONSTRAINT "NoteShare_noteId_fkey"
    FOREIGN KEY ("noteId") REFERENCES "Note"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteShare"
    ADD CONSTRAINT "NoteShare_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteShare"
    ADD CONSTRAINT "NoteShare_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
