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
  'START_TIMER',
  'STOP_TIMER',
] as const;

export type CoachActionType = (typeof COACH_ACTION_TYPES)[number];

export class CoachProposedAction {
  @ApiProperty({ enum: COACH_ACTION_TYPES })
  @IsIn(COACH_ACTION_TYPES as unknown as string[])
  type: CoachActionType;

  @ApiPropertyOptional({
    description: 'Target entity id (for UPDATE/DELETE/RENAME)',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Action payload — shape depends on type',
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      "For UPDATE_SCHEDULE_BLOCK: the block's title as the Coach currently believes it to be, BEFORE this action's changes are applied. Used purely as an identity check against the row `id` resolves to — never written. Distinct from payload.title, which (when present) is the NEW title to rename to. Lets the backend reject an action that targets the wrong block (id resolves, but to a block with a different title than the Coach intended) and lets stale-id recovery re-match a deleted-and-recreated block by title.",
  })
  @IsOptional()
  @IsString()
  expectedTitle?: string;
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

  /**
   * Per-item confirmation for destructive actions. A delete is unrecoverable
   * and, before this existed, one could ride along inside a batch the user
   * approved for some other reason (create a goal, link some blocks, and by
   * the way delete these four things).
   *
   * Semantics are opt-in-and-then-strict: send the field and EVERY DELETE_* in
   * the batch must have its target id listed, or the whole batch is refused.
   * Omit it and the batch still has to pass the destructive-count caps in
   * coach-ai/safety/action-safety.ts. Omitting it becomes fatal once the
   * operator sets COACH_REQUIRE_DELETE_CONFIRMATION=true, which is the switch
   * to flip after the web and mobile clients ship the confirmation UI.
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      'Ids of every DELETE_* action the user explicitly confirmed. When present, any delete whose id is missing from this list fails the batch.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  confirmDeletions?: string[];
}

export interface CoachActionResult {
  index: number;
  type: CoachActionType;
  ok: boolean;
  resultId?: string;
  error?: string;
}
