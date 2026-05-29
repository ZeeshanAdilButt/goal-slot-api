import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachInsightsController } from './coach-insights.controller';
import { CoachInsightsService } from './coach-insights.service';

@Module({
  imports: [AuthModule],
  controllers: [CoachInsightsController],
  providers: [CoachInsightsService],
  exports: [CoachInsightsService],
})
export class CoachInsightsModule {}
