import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachReflectionController } from './coach-reflection.controller';
import { CoachReflectionService } from './coach-reflection.service';

@Module({
  imports: [AuthModule],
  controllers: [CoachReflectionController],
  providers: [CoachReflectionService],
  exports: [CoachReflectionService],
})
export class CoachReflectionModule {}
