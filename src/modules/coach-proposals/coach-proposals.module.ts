import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { CoachInsightsModule } from '../coach-insights/coach-insights.module';
import { GoalsModule } from '../goals/goals.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { TimeEntriesModule } from '../time-entries/time-entries.module';
import { TasksModule } from '../tasks/tasks.module';
import { ActiveTimerModule } from '../active-timer/active-timer.module';
import { CoachJournalModule } from '../coach-journal/coach-journal.module';
import { UserThrottlerGuard } from '../coach-ai/user-throttler.guard';
import { CoachProposalsController } from './coach-proposals.controller';
import { CoachProposalsService } from './coach-proposals.service';

/**
 * Apply is the only Coach endpoint that WRITES, up to 200 rows per call, and
 * it had no rate limit of any kind — the throttler is registered inside
 * CoachAiModule and ThrottlerModule.forRoot is not global, so nothing here
 * inherited it. A separate registration gives this module its own storage and
 * its own bucket, which is what we want: applying proposals should not consume
 * the daily chat allowance.
 *
 * 60/hour per user is far above interactive use (a user reviewing and applying
 * a card at a time) and far below what a script would want.
 */
const PROPOSALS_APPLY_TTL_MS = 3_600_000;
const PROPOSALS_APPLY_LIMIT = 60;

@Module({
  imports: [
    AuthModule,
    CoachInsightsModule,
    GoalsModule,
    ScheduleModule,
    TimeEntriesModule,
    TasksModule,
    ActiveTimerModule,
    // Backs APPEND_JOURNAL_ENTRY. Imported for its exported
    // CoachJournalService so the Coach writes through the same service the
    // /coach/journal/entries endpoints use, rather than a Coach-only copy of
    // the append rule.
    CoachJournalModule,
    ThrottlerModule.forRoot([
      {
        name: 'coach-proposals',
        ttl: PROPOSALS_APPLY_TTL_MS,
        limit: PROPOSALS_APPLY_LIMIT,
      },
    ]),
  ],
  controllers: [CoachProposalsController],
  providers: [CoachProposalsService, UserThrottlerGuard],
})
export class CoachProposalsModule {}
