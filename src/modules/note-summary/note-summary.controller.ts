import { Controller, Param, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../coach-ai/user-throttler.guard';
import { NoteSummaryService } from './note-summary.service';
import { NoteSummaryResponseDto } from './dto/note-summary.dto';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';
import {
  NOTE_SUMMARY_DAILY_LIMIT,
  NOTE_SUMMARY_DAILY_TTL_MS,
  NOTE_SUMMARY_HOURLY_LIMIT,
  NOTE_SUMMARY_HOURLY_TTL_MS,
} from './note-summary.limits';

/**
 * Lives on its own controller rather than on `NotesController` deliberately:
 * putting it there would make `NotesModule` depend on `CoachAiModule`, and
 * `CoachProposalsModule` already imports `NotesModule` — the notes module
 * needs to stay free of AI dependencies to keep that graph acyclic.
 *
 * The route still reads as `/notes/:id/summary`, which is where it belongs
 * from the client's point of view. Two controllers sharing the `notes` prefix
 * is fine; the paths do not overlap.
 */
@ApiTags('notes')
@Controller('notes')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NoteSummaryController {
  constructor(private readonly noteSummary: NoteSummaryService) {}

  @Post(':id/summary')
  @UseGuards(UserThrottlerGuard)
  @Throttle({
    'note-summary-hourly': {
      limit: NOTE_SUMMARY_HOURLY_LIMIT,
      ttl: NOTE_SUMMARY_HOURLY_TTL_MS,
    },
    'note-summary-daily': {
      limit: NOTE_SUMMARY_DAILY_LIMIT,
      ttl: NOTE_SUMMARY_DAILY_TTL_MS,
    },
  })
  @ApiOperation({
    summary:
      'Summarize a long note into a new, well-structured child note. Never modifies the source.',
    description:
      'One non-streaming generation call. The source note is read owner-only and left untouched; ' +
      'the summary is created as a child of it. Metered against the same BYOK budget / shared-key ' +
      'daily quota as Coach chat, on top of the per-user rate limits above.',
  })
  async summarize(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<NoteSummaryResponseDto> {
    return this.noteSummary.summarize(req.user.sub, id);
  }
}
