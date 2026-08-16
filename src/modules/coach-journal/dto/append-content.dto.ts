import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { YYYY_MM_DD } from '../date';

/**
 * Append a paragraph to one day's journal entry, creating that day if it does
 * not exist yet.
 *
 * This is also the payload contract for the Coach's `APPEND_JOURNAL_ENTRY`
 * proposal action (see coach-proposals.service.ts): the proposals service
 * validates the model-authored payload against this class with
 * `forbidNonWhitelisted`, so the field list here IS the whitelist. That is
 * what stops a Coach payload from carrying a `userId` and re-parenting the
 * row onto another account.
 *
 * Deliberately NARROWER than UpsertJournalEntryDto: no `mood`/`energy`. Those
 * are single-valued fields that can only ever be replaced, and folding a
 * replace into an action whose entire contract is "append, never overwrite"
 * would make the approval card's promise untrue for part of its own payload.
 */
export class AppendJournalContentDto {
  @ApiProperty({
    description:
      'Plain-text paragraph to append. Added as its own paragraph after whatever the entry already holds; never replaces it.',
  })
  @IsString()
  // Deliberately far below the 65535 an entry can hold in total: this is one
  // dictated or typed paragraph, not a whole document. appendContent()
  // separately refuses to push the resulting entry past 65535, so an entry
  // grown by repeated appends always stays within what the journal editor's
  // own PUT (UpdateJournalContentDto) can save back.
  @MaxLength(10000)
  content!: string;

  @ApiPropertyOptional({
    example: '2026-05-27',
    description:
      "Day to append to. Omit for today. Clients that know the user's local date should send it explicitly — the server-side fallback is UTC, which is a day off for a user far enough east or west.",
  })
  @IsOptional()
  @IsString()
  @Matches(YYYY_MM_DD, { message: 'date must match YYYY-MM-DD' })
  date?: string;
}
