import { Module } from '@nestjs/common';
import { TimeEntriesController } from './time-entries.controller';
import { TimeEntriesService } from './time-entries.service';
import { GoalsModule } from '../goals/goals.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [GoalsModule, AuthModule],
  controllers: [TimeEntriesController],
  providers: [TimeEntriesService],
  exports: [TimeEntriesService],
})
export class TimeEntriesModule {}
