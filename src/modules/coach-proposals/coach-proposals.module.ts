import { Module } from '@nestjs/common';
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
