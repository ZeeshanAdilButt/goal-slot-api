import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { CoachAiModule } from '../coach-ai/coach-ai.module';
import { UserThrottlerGuard } from '../coach-ai/user-throttler.guard';
import { CoachVoiceIntentController } from './coach-voice-intent.controller';
import { CoachVoiceIntentService } from './coach-voice-intent.service';

/**
 * A separate ThrottlerModule.forRoot registration, exactly like coach-ai and
 * coach-proposals each get their own — the throttler storage is not global,
 * so each module's buckets are independent.
 *
 * Limits are deliberately much more generous than the 30/24h full-chat
 * limit in coach-ai.module.ts: this endpoint is meant to fire on nearly
 * every voice utterance, not once per typed message. Two named throttlers
 * combine a short burst allowance (rapid-fire commands in one session) with
 * a generous daily ceiling (sustained use across a whole day), rather than
 * one number that has to compromise between the two.
 */
const VOICE_INTENT_BURST_LIMIT = 20;
const VOICE_INTENT_BURST_TTL_MS = 60_000;
const VOICE_INTENT_DAILY_LIMIT = 600;
const VOICE_INTENT_DAILY_TTL_MS = 86_400_000;

@Module({
  imports: [
    AuthModule,
    CoachAiModule, // for CoachAiService.resolveCoachKey
    ThrottlerModule.forRoot([
      {
        name: 'coach-voice-intent-burst',
        ttl: VOICE_INTENT_BURST_TTL_MS,
        limit: VOICE_INTENT_BURST_LIMIT,
      },
      {
        name: 'coach-voice-intent-daily',
        ttl: VOICE_INTENT_DAILY_TTL_MS,
        limit: VOICE_INTENT_DAILY_LIMIT,
      },
    ]),
  ],
  controllers: [CoachVoiceIntentController],
  providers: [CoachVoiceIntentService, UserThrottlerGuard],
})
export class CoachVoiceIntentModule {}
