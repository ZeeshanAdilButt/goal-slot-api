import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { CoachAiController } from './coach-ai.controller';
import { CoachAiService } from './coach-ai.service';
import { UserThrottlerGuard } from './user-throttler.guard';

const COACH_TTL_MS = 86_400_000;
const COACH_LIMIT = 30;

@Module({
  imports: [
    AuthModule,
    ThrottlerModule.forRoot([
      { name: 'coach-ai', ttl: COACH_TTL_MS, limit: COACH_LIMIT },
    ]),
  ],
  controllers: [CoachAiController],
  providers: [CoachAiService, UserThrottlerGuard],
  exports: [CoachAiService],
})
export class CoachAiModule {}
