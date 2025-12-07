import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { AuthModule } from '../auth/auth.module';
import { GoalsModule } from '../goals/goals.module';

@Module({
  imports: [AuthModule, GoalsModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}

