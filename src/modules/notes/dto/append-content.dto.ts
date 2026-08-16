import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Append a paragraph to an existing note, found by title hint rather than id.
 *
 * This is also the payload contract for the Coach's `APPEND_NOTE_CONTENT`
 * proposal action (see coach-proposals.service.ts): the proposals service
 * validates the model-authored payload against this class with
 * `forbidNonWhitelisted`, so the field list here IS the whitelist. That is
 * what stops a Coach payload from carrying a `userId` (or a note `id`, which
 * would skip the title-matching entirely) and writing into a row it should
 * not be able to reach.
 *
 * No `id` field on purpose: unlike goals/tasks/schedule blocks, the Coach is
 * never given the user's note titles or ids in its chat context, so it has
 * nothing to echo back. `titleHint` is resolved against the user's own notes
 * server-side (see `NotesService.appendContentByTitleHint` /
 * `matchNotesByTitle` in note-content.ts) — exact title match preferred,
 * substring fallback, and an ambiguous or absent match fails the action with
 * a message explaining why rather than guessing which page was meant or
 * creating a new one.
 */
export class AppendNoteContentDto {
  @ApiProperty({
    example: 'research papers',
    description:
      "The note's title, or a fragment of it, as the user named it. Matched case-insensitively against the user's own notes; an exact match is preferred, and a substring match is used only when exactly one note qualifies.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  titleHint!: string;

  @ApiProperty({
    description:
      "Plain-text paragraph to append. Added as its own paragraph after whatever the note already holds; never replaces the note's existing content.",
  })
  @IsString()
  @IsNotEmpty()
  // Same ceiling as AppendJournalContentDto's content field: one paragraph
  // being added, not a whole document being pasted in.
  @MaxLength(10000)
  content!: string;
}
