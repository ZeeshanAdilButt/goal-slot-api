import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * One Coach-proposed action. Validation here is intentionally permissive at
 * the wrapper level — each action's typed payload is validated by the
 * underlying service (GoalsService.update, ScheduleService.create, etc.) so
 * we don't drift from existing rules (plan limits, conflict checks, etc.).
 */
export const COACH_ACTION_TYPES = [
  'RENAME_GOAL',
  'UPDATE_GOAL',
  'CREATE_GOAL',
  'DELETE_GOAL',
  'CREATE_SCHEDULE_BLOCK',
  'UPDATE_SCHEDULE_BLOCK',
  'DELETE_SCHEDULE_BLOCK',
  'CREATE_TIME_ENTRY',
  'UPDATE_TIME_ENTRY',
  'DELETE_TIME_ENTRY',
  'CREATE_TASK',
  'UPDATE_TASK',
  'DELETE_TASK',
  'CREATE_PRACTICE',
] as const;

export type CoachActionType = (typeof COACH_ACTION_TYPES)[number];

export class CoachProposedAction {
  @ApiProperty({ enum: COACH_ACTION_TYPES })
  @IsIn(COACH_ACTION_TYPES as unknown as string[])
  type: CoachActionType;

  @ApiPropertyOptional({ description: 'Target entity id (for UPDATE/DELETE/RENAME)' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({ description: 'Action payload — shape depends on type' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, any>;
}

export class ApplyProposalsDto {
  @ApiProperty({ type: [CoachProposedAction] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CoachProposedAction)
  actions: CoachProposedAction[];

  @ApiPropertyOptional({
    description:
      'Source chat message id (assistant message that emitted the proposal). Used purely for the audit trail.',
  })
  @IsOptional()
  @IsString()
  sourceMessageId?: string;
}

export interface CoachActionResult {
  index: number;
  type: CoachActionType;
  ok: boolean;
  resultId?: string;
  error?: string;
}
