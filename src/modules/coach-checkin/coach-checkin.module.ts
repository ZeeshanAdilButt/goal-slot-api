import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachCheckinController } from './coach-checkin.controller';
import { CoachCheckinService } from './coach-checkin.service';

@Module({
  imports: [AuthModule],
  controllers: [CoachCheckinController],
  providers: [CoachCheckinService],
  exports: [CoachCheckinService],
})
export class CoachCheckinModule {}
