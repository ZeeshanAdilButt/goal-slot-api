import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoachInsightKind } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Payload contract for landing a Coach-proposed practice directly into
 * Active Practice (see `CoachInsightsService.createAccepted`).
 *
 * This is also the payload contract for the Coach's `CREATE_PRACTICE`
 * proposal action (see coach-proposals.service.ts): the proposals service
 * validates the model-authored payload against this class with
 * `forbidNonWhitelisted`, so the field list here IS the whitelist. That is
 * what stops a Coach payload from carrying a `userId` (or any other column
 * `createAccepted` doesn't intentionally expose) and re-parenting the row
 * onto another account.
 *
 * `sourceMessageId` / `sourceConversationId` are deliberately NOT here even
 * though `createAccepted`'s own parameter type accepts them: the CREATE_PRACTICE
 * section of the Coach system prompt (coach-ai.service.ts) never tells the
 * model to send them, and `CoachProposalsService.dispatch` has no verified
 * conversation/message context of its own to cross-check them against (unlike
 * `saveChatMessageAsInsight`, which looks the message up and checks
 * `conversation.userId` before trusting it). Letting a payload set them would
 * mean accepting two opaque, arbitrary-length, model-chosen strings with no
 * ownership check at all. They fall back to `null` on this path; the two
 * other writers of CoachInsight.source* (saveChatMessageAsInsight and the
 * background insight-extraction pipeline) set them server-side from data they
 * already resolved and verified themselves.
 */
export class CreatePracticeDto {
  @ApiProperty({
    example: 'Read 5 ayat of Surah Mulk after Maghrib',
    description:
      'Short, specific title naming the thing to DO (the prompt asks for 4-8 words).',
  })
  @IsString()
  @IsNotEmpty()
  // Generous relative to the prompt's "4-8 words" guidance so a longer word
  // or two never clips a legitimate title, while still bounding the field.
  @MaxLength(100)
  title!: string;

  @ApiProperty({
    description:
      'Full practice body: what to do and everything needed to do it without leaving the app. The prompt requires the FULL text of any dua/ayah/hadith referenced (Arabic/transliteration, translation, source), not a summary, so this intentionally allows more than a couple of sentences.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({
    example: 'Set a phone alarm 15 min before Fajr tonight.',
    description:
      'One sentence: the immediate next step the user can take today.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  suggestedAction?: string;

  @ApiPropertyOptional({ enum: CoachInsightKind })
  @IsOptional()
  @IsEnum(CoachInsightKind)
  kind?: CoachInsightKind;

  @ApiPropertyOptional({
    description:
      'Time-of-day slot this practice is best surfaced in, only meaningful when kind is MEDIA_PROMPT.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  mediaSlot?: string;

  @ApiPropertyOptional({
    description:
      'Topic tag for this practice, only meaningful when kind is MEDIA_PROMPT.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  mediaTopic?: string;
}
