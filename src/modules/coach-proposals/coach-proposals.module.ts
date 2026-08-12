import { Module } from '@nestjs/common';
import { ActiveTimerModule } from '../active-timer/active-timer.module';
import { AuthModule } from '../auth/auth.module';
import { CoachInsightsModule } from '../coach-insights/coach-insights.module';
import { GoalsModule } from '../goals/goals.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { TimeEntriesModule } from '../time-entries/time-entries.module';
import { TasksModule } from '../tasks/tasks.module';
import { CoachProposalsController } from './coach-proposals.controller';
import { CoachProposalsService } from './coach-proposals.service';

@Module({
  imports: [
    // START_TIMER / STOP_TIMER dispatch onto ActiveTimerService rather than
    // re-implementing the session lifecycle, so the Coach path and the
    // clients' own timer buttons share one set of conflict, cap and rounding
    // rules. ActiveTimerModule already exports the service.
    ActiveTimerModule,
    AuthModule,
    CoachInsightsModule,
    GoalsModule,
    ScheduleModule,
    TimeEntriesModule,
    TasksModule,
  ],
  controllers: [CoachProposalsController],
  providers: [CoachProposalsService],
})
export class CoachProposalsModule {}
