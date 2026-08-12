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
  // Live stopwatch, distinct from CREATE_TIME_ENTRY: those two verbs are not
  // interchangeable. CREATE_TIME_ENTRY logs work that is already finished and
  // whose duration is known; START_TIMER/STOP_TIMER drive the shared
  // ActiveTimerSession, where the duration is not known until the user stops.
  // Without these, "start tracking time for my deen goal" has no action the
  // model can express and the ask silently produces prose instead.
  'START_TIMER',
  'STOP_TIMER',
] as const;

/**
 * MIRRORED CLIENT-SIDE. Both clients keep their own copy of this list and
 * DROP any action whose type is not on it (see `normalizeCoachActionType`),
 * so a type added here but not there is emitted by the model and then
 * silently discarded before it ever reaches /apply:
 *
 *   dw-time-mobile  packages/shared/src/api/coach.ts        (union + array)
 *                   apps/mobile/app/(app)/coach.tsx         (ACTION_LABELS)
 *   dw-time-web     src/lib/api.ts                          (union + array)
 *                   src/features/coach/components/coach-proposal-card.tsx
 *
 * Adding a type is therefore a three-repo change, in that order.
 */

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
  // Cap is generous because a single coherent proposal — e.g. an unusually
  // detailed week with many distinct blocks that don't collapse into a
  // multi-day series — legitimately runs to well over a hundred actions (a
  // real user hit 107 and got rejected). Chunking client-side is NOT a safe
  // alternative: payloads use "$ref:N" tokens that resolve against earlier
  // results in the SAME apply() call, so splitting a batch would break a
  // schedule block that references a goal created in the same run. Actions
  // dispatch sequentially, so a large batch is just N sequential ops; 200
  // bounds worst-case latency while comfortably covering real proposals.
  @ApiProperty({ type: [CoachProposedAction], maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
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
  /**
   * Set on an action that succeeded (`ok: true`) but did something other
   * than exactly what was asked — e.g. STOP_TIMER saving less time than was
   * actually tracked because the session hit MAX_SESSION_MS. Distinct from
   * `error`, which is reserved for actions that did NOT apply: a warning
   * means the write happened and the user should still see why the result
   * isn't the full picture.
   */
  warning?: string;
}
