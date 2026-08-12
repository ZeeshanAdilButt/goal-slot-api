import { Module } from '@nestjs/common';
import { ActiveTimerController } from './active-timer.controller';
import { ActiveTimerService } from './active-timer.service';
import { AuthModule } from '../auth/auth.module';
import { GoalsModule } from '../goals/goals.module';

@Module({
  imports: [AuthModule, GoalsModule],
  controllers: [ActiveTimerController],
  providers: [ActiveTimerService],
  exports: [ActiveTimerService],
})
export class ActiveTimerModule {}
