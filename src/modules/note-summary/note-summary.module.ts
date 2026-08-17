import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { CoachAiModule } from '../coach-ai/coach-ai.module';
import { UserThrottlerGuard } from '../coach-ai/user-throttler.guard';
import { NotesModule } from '../notes/notes.module';
import { NoteSummaryController } from './note-summary.controller';
import { NoteSummaryService } from './note-summary.service';
import {
  NOTE_SUMMARY_DAILY_LIMIT,
  NOTE_SUMMARY_DAILY_TTL_MS,
  NOTE_SUMMARY_HOURLY_LIMIT,
  NOTE_SUMMARY_HOURLY_TTL_MS,
} from './note-summary.limits';

/**
 * Its own `ThrottlerModule.forRoot`, exactly like coach-ai, coach-proposals
 * and coach-voice-intent each get one — the throttler's storage is not global,
 * so a module that does not register its own has no buckets of its own either.
 *
 * Imports both `CoachAiModule` (key resolution + the quota gates) and
 * `NotesModule` (owner-only read, and the create). Neither imports the other,
 * and `NotesModule` still depends on nothing but Prisma, so this stays acyclic
 * — which is the whole reason the route is not on `NotesController`.
 */
@Module({
  imports: [
    AuthModule,
    CoachAiModule,
    NotesModule,
    ThrottlerModule.forRoot([
      {
        name: 'note-summary-hourly',
        ttl: NOTE_SUMMARY_HOURLY_TTL_MS,
        limit: NOTE_SUMMARY_HOURLY_LIMIT,
      },
      {
        name: 'note-summary-daily',
        ttl: NOTE_SUMMARY_DAILY_TTL_MS,
        limit: NOTE_SUMMARY_DAILY_LIMIT,
      },
    ]),
  ],
  controllers: [NoteSummaryController],
  providers: [NoteSummaryService, UserThrottlerGuard],
})
export class NoteSummaryModule {}
