import { BadRequestException } from '@nestjs/common';
import {
  CoachActionType,
  CoachProposedAction,
} from '../../coach-proposals/dto/apply-proposals.dto';

/**
 * Blast-radius guards for a Coach proposal batch.
 *
 * WHY THIS IS SEPARATE FROM THE PROPOSALS SERVICE
 * -----------------------------------------------
 * These are properties of the AI layer, not of the apply endpoint's
 * authorization: the question is not "may this user touch this row" (the
 * domain services already answer that from the JWT userId) but "is this batch
 * a plausible thing a coach would propose, or does it look like a model that
 * has been talked into something". Keeping it as pure functions in coach-ai/
 * means the file has no DI, no Prisma, and can be unit-tested directly, and it
 * leaves the apply path's own validation to the proposals service.
 *
 * WHAT IT DEFENDS
 * ---------------
 * A hallucinated or injected delete is unrecoverable. DELETE_GOAL is the worst
 * of them: the row goes, its GoalReflection rows cascade with it, and every
 * TimeEntry / Task / ScheduleBlock that pointed at it is silently unlinked
 * (onDelete: SetNull), so the user loses the history association even though
 * the entries survive. One click on a poisoned approval card could previously
 * take out every goal in the account, because ApplyProposalsDto allows 200
 * actions and nothing counted how many of them were deletes.
 *
 * The caps below are deliberately set well above what a real coach proposal
 * does and well below "your whole account". They are a blast-radius ceiling,
 * not a correctness check.
 */

export const DESTRUCTIVE_COACH_ACTION_TYPES: readonly CoachActionType[] = [
  'DELETE_GOAL',
  'DELETE_TASK',
  'DELETE_SCHEDULE_BLOCK',
  'DELETE_TIME_ENTRY',
];

const DESTRUCTIVE_SET = new Set<string>(DESTRUCTIVE_COACH_ACTION_TYPES);

/** Total DELETE_* actions allowed in one batch. */
const DEFAULT_MAX_DESTRUCTIVE = 10;

/**
 * DELETE_GOAL allowance, stricter than the overall one because it is the only
 * delete that takes related rows and links with it. Tidying up two or three
 * stale goals in one proposal is a real thing users do; fifteen is not.
 */
const DEFAULT_MAX_GOAL_DELETIONS = 3;

/**
 * Depth and size ceilings on a single action payload. `resolveRefs` in the
 * proposals service walks the payload recursively to substitute "$ref:N"
 * tokens, so a deeply nested payload from an adversarial stream is a stack
 * overflow waiting to happen, and a very wide one is unbounded work before any
 * ownership check runs.
 */
const MAX_PAYLOAD_DEPTH = 12;
const MAX_PAYLOAD_NODES = 2000;

/**
 * Config is read per call, never in a constructor, so a missing or changed env
 * var can never take the API down at bootstrap.
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function maxDestructiveActionsPerBatch(): number {
  return intFromEnv('COACH_MAX_DESTRUCTIVE_ACTIONS', DEFAULT_MAX_DESTRUCTIVE);
}

export function maxGoalDeletionsPerBatch(): number {
  return intFromEnv('COACH_MAX_GOAL_DELETIONS', DEFAULT_MAX_GOAL_DELETIONS);
}

/**
 * When true, EVERY delete in a batch must have its target id echoed back in
 * `confirmDeletions`, so a delete can never ride along unnoticed inside a
 * batch the user approved for some other reason.
 *
 * Defaults to false because turning it on without the matching web and mobile
 * release would 400 every delete the moment this deploys. The mechanism is
 * fully implemented and enforced whenever a client does send the field; the
 * flag only controls whether omitting it is fatal. See the PR body.
 */
export function deleteConfirmationRequired(): boolean {
  return process.env.COACH_REQUIRE_DELETE_CONFIRMATION === 'true';
}

export function isDestructiveActionType(type: string): boolean {
  return DESTRUCTIVE_SET.has(type);
}

/**
 * Validate the shape and blast radius of a whole batch BEFORE any action is
 * dispatched. Throwing here means nothing was applied, which matters because
 * apply() dispatches sequentially and does not roll back: a cap enforced
 * mid-loop would leave a half-applied batch behind.
 */
export function assertProposalBatchSafe(
  actions: CoachProposedAction[],
  opts: { confirmedDeleteIds?: string[] } = {},
): void {
  for (let i = 0; i < actions.length; i++) {
    assertPayloadShape(actions[i]?.payload, i);
  }

  const destructive = actions.filter((a) => isDestructiveActionType(a.type));
  if (destructive.length === 0) return;

  const destructiveCap = maxDestructiveActionsPerBatch();
  if (destructive.length > destructiveCap) {
    throw new BadRequestException(
      `This proposal contains ${destructive.length} delete actions, above the ${destructiveCap} allowed in one batch. ` +
        'Deletes cannot be undone, so a batch this destructive is refused. Ask the Coach for the deletions in smaller, reviewable groups.',
    );
  }

  const goalDeletes = destructive.filter((a) => a.type === 'DELETE_GOAL');
  const goalCap = maxGoalDeletionsPerBatch();
  if (goalDeletes.length > goalCap) {
    throw new BadRequestException(
      `This proposal deletes ${goalDeletes.length} goals, above the ${goalCap} allowed in one batch. ` +
        'Deleting a goal also removes its weekly reflections and unlinks its time entries, so goal deletions are capped harder than other deletes.',
    );
  }

  // Per-item confirmation. Supplying the field at all opts into strict mode:
  // a client that knows about confirmations must account for every delete in
  // the batch, otherwise a partial list would be worse than none.
  const strict = opts.confirmedDeleteIds !== undefined || deleteConfirmationRequired();
  if (!strict) return;

  const confirmed = new Set(opts.confirmedDeleteIds ?? []);
  const unconfirmed = destructive.filter((a) => !a.id || !confirmed.has(a.id));
  if (unconfirmed.length > 0) {
    const preview = unconfirmed
      .slice(0, 5)
      .map((a) => `${a.type}(${a.id ?? 'no id'})`)
      .join(', ');
    throw new BadRequestException(
      `${unconfirmed.length} delete action(s) were not individually confirmed: ${preview}. ` +
        'Each delete must have its target id listed in confirmDeletions before it will be applied.',
    );
  }
}

/**
 * Reject payloads that are too deep or too large to walk safely. Runs before
 * anything is dispatched and before `resolveRefs` recurses over the same
 * structure.
 */
function assertPayloadShape(payload: unknown, index: number): void {
  if (payload === undefined || payload === null) return;

  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_PAYLOAD_NODES) {
      throw new BadRequestException(
        `Action ${index} payload has more than ${MAX_PAYLOAD_NODES} fields, which is not a shape the Coach produces.`,
      );
    }
    if (depth > MAX_PAYLOAD_DEPTH) {
      throw new BadRequestException(
        `Action ${index} payload is nested deeper than ${MAX_PAYLOAD_DEPTH} levels, which is not a shape the Coach produces.`,
      );
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) {
        visit(v, depth + 1);
      }
    }
  };

  visit(payload, 1);
}
