import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Request/response shapes for POST /coach/voice-intent — the fast, cheap
 * first-pass classifier described in coach-voice-intent.service.ts. Kept in
 * its own small module (not bolted onto coach-ai) because it is a
 * fundamentally different call shape: no context-bundle assembly, no
 * streaming, a single tight structured-output request instead of a full
 * conversation.
 */

export const TIMER_STATUS_VALUES = ['idle', 'running', 'paused'] as const;
export type TimerStatus = (typeof TIMER_STATUS_VALUES)[number];

export class CandidateGoalDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  title!: string;
}

export class CandidateTaskDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  goalId?: string;
}

export class VoiceIntentContextDto {
  // Capped well above what a real account's active goal/task list looks
  // like. This whole request is meant to be small and cheap; an
  // unbounded list here would defeat that and blow up the prompt.
  @ApiProperty({ type: [CandidateGoalDto], maxItems: 150 })
  @IsArray()
  @ArrayMaxSize(150)
  @ValidateNested({ each: true })
  @Type(() => CandidateGoalDto)
  candidateGoals!: CandidateGoalDto[];

  @ApiProperty({ type: [CandidateTaskDto], maxItems: 300 })
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => CandidateTaskDto)
  candidateTasks!: CandidateTaskDto[];

  @ApiProperty({ enum: TIMER_STATUS_VALUES })
  @IsIn(TIMER_STATUS_VALUES as unknown as string[])
  timerStatus!: TimerStatus;
}

export class VoiceIntentRequestDto {
  // Voice utterances are short. 2000 chars is generous headroom (a very
  // long rambling dictation) while keeping the classification prompt small,
  // which is the whole point of this endpoint.
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  transcript!: string;

  @ApiProperty({ type: VoiceIntentContextDto })
  @ValidateNested()
  @Type(() => VoiceIntentContextDto)
  context!: VoiceIntentContextDto;
}

export const VOICE_INTENT_VALUES = [
  'START_TRACKING',
  'STOP_TRACKING',
  'PAUSE',
  'RESUME',
  'APPEND_NOTE',
  'APPEND_JOURNAL',
  'CREATE_TASK',
  'CREATE_GOAL',
  'DAY_QUERY',
  'CHAT',
  'UNKNOWN',
] as const;
export type VoiceIntent = (typeof VOICE_INTENT_VALUES)[number];

export interface VoiceIntentTarget {
  kind: 'goal' | 'task';
  id: string;
}

export interface VoiceIntentResponse {
  intent: VoiceIntent;
  confidence: 'high' | 'low';
  target: VoiceIntentTarget | null;
  text: string | null;
  reasoning: string;
}
