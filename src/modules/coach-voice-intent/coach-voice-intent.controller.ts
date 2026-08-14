import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../coach-ai/user-throttler.guard';
import { CoachVoiceIntentService } from './coach-voice-intent.service';
import {
  VoiceIntentRequestDto,
  VoiceIntentResponse,
} from './dto/voice-intent.dto';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';

// Kept in step with the ThrottlerModule.forRoot registration in
// coach-voice-intent.module.ts — see that file for the reasoning on why
// this is far more generous than the 30/24h full-chat limit.
const VOICE_INTENT_BURST_LIMIT = 20;
const VOICE_INTENT_BURST_TTL_MS = 60_000;
const VOICE_INTENT_DAILY_LIMIT = 600;
const VOICE_INTENT_DAILY_TTL_MS = 86_400_000;

@ApiTags('coach-voice-intent')
@Controller('coach')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachVoiceIntentController {
  constructor(private readonly voiceIntent: CoachVoiceIntentService) {}

  @Post('voice-intent')
  @UseGuards(UserThrottlerGuard)
  @Throttle({
    'coach-voice-intent-burst': {
      limit: VOICE_INTENT_BURST_LIMIT,
      ttl: VOICE_INTENT_BURST_TTL_MS,
    },
    'coach-voice-intent-daily': {
      limit: VOICE_INTENT_DAILY_LIMIT,
      ttl: VOICE_INTENT_DAILY_TTL_MS,
    },
  })
  @ApiOperation({
    summary:
      'Classify a voice transcript into a fast action intent (start/stop timer, quick note, etc.) or hand off to the full Coach.',
    description:
      'One small, non-streaming structured-output call — no context-bundle assembly, no conversation history. ' +
      'Meant to be called on nearly every voice utterance, so it deliberately does not share the full Coach ' +
      "chat's daily shared-key quota; see CoachVoiceIntentService for details.",
  })
  async classify(
    @Request() req: AuthenticatedRequest,
    @Body() body: VoiceIntentRequestDto,
  ): Promise<VoiceIntentResponse> {
    return this.voiceIntent.classify(req.user.sub, body);
  }
}
