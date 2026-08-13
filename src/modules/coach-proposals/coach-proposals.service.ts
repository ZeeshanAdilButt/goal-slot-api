import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { GoalsService } from '../goals/goals.service';
import { ScheduleService } from '../schedule/schedule.service';
import { TimeEntriesService } from '../time-entries/time-entries.service';
import { TasksService } from '../tasks/tasks.service';
import { CoachInsightsService } from '../coach-insights/coach-insights.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CoachActionResult,
  CoachProposedAction,
} from './dto/apply-proposals.dto';
import { assertProposalBatchSafe } from '../coach-ai/safety/action-safety';

/**
 * Dispatches Coach-proposed actions onto the existing domain services.
 *
 * Security model:
 *   - Every action is dispatched with `userId` from the JWT — services already
 *     enforce row-level ownership via findFirst({ where: { id, userId } }).
 *   - We never trust ids in the payload to bypass that check. If the Coach
 *     hallucinates an id that doesn't belong to the user, the underlying
 *     service throws NotFoundException and we mark the action failed.
 *   - Actions are dispatched sequentially (not in a $transaction) so a single
 *     bad action doesn't roll back the user-approved good ones. Each result
 *     is reported back per-action so the UI can show what succeeded/failed.
 *
 * Stale ids:
 *   - A proposal card can sit unapplied in chat history for a while. If the
 *     user edits their schedule directly (outside the chat) in the meantime,
 *     an id embedded in an old card can go dead before it's ever applied.
 *   - UPDATE_SCHEDULE_BLOCK recovers from this (see resolveStaleScheduleBlock
 *     below) by re-matching the target block on the CURRENT schedule instead
 *     of failing outright. DELETE_SCHEDULE_BLOCK (and the other DELETE_*
 *     actions) instead treat "already gone" as success via deleteIdempotent,
 *     since the desired end state for a delete is reached either way.
 */
@Injectable()
export class CoachProposalsService {
  private readonly logger = new Logger(CoachProposalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly goals: GoalsService,
    private readonly schedule: ScheduleService,
    private readonly timeEntries: TimeEntriesService,
    private readonly tasks: TasksService,
    private readonly insights: CoachInsightsService,
  ) {}

  async apply(
    userId: string,
    actions: CoachProposedAction[],
    opts: { confirmedDeleteIds?: string[] } = {},
  ): Promise<CoachActionResult[]> {
    // Blast-radius check for the whole batch, before anything is dispatched.
    // It has to run here rather than inside the loop: dispatch is sequential
    // and deliberately not transactional, so a cap that tripped mid-batch
    // would leave the earlier actions already written.
    assertProposalBatchSafe(actions, opts);

    const results: CoachActionResult[] = [];

    for (let i = 0; i < actions.length; i++) {
      const raw = actions[i];
      // Resolve any "$ref:N" tokens in the payload against previous results in
      // this batch. Lets Coach bundle e.g. CREATE_GOAL + N CREATE_SCHEDULE_BLOCK
      // actions, with the blocks linking goalId: "$ref:0" to the just-created
      // goal, so the user can log time against the goal as soon as they click apply.
      const action: CoachProposedAction = {
        ...raw,
        payload: resolveRefs(raw.payload, results),
      };
      try {
        const resultId = await this.dispatch(userId, action);
        results.push({ index: i, type: action.type, ok: true, resultId });
      } catch (err: any) {
        const message =
          err?.response?.message ??
          err?.message ??
          'Unknown error applying action';
        this.logger.warn(
          `Coach action failed userId=${userId} type=${action.type} id=${action.id ?? '-'}: ${message}`,
        );
        results.push({
          index: i,
          type: action.type,
          ok: false,
          error: String(message),
        });
      }
    }

    return results;
  }

  private async dispatch(
    userId: string,
    action: CoachProposedAction,
  ): Promise<string | undefined> {
    const payload = action.payload ?? {};

    switch (action.type) {
      // -------- Goals --------
      case 'RENAME_GOAL': {
        if (!action.id) throw new Error('RENAME_GOAL requires id');
        if (typeof payload.title !== 'string' || !payload.title.trim()) {
          throw new Error('RENAME_GOAL requires payload.title');
        }
        const updated = await this.goals.update(userId, action.id, {
          title: payload.title.trim(),
        } as any);
        return updated?.id;
      }
      case 'UPDATE_GOAL': {
        if (!action.id) throw new Error('UPDATE_GOAL requires id');
        const updated = await this.goals.update(userId, action.id, payload as any);
        return updated?.id;
      }
      case 'CREATE_GOAL': {
        if (typeof payload.title !== 'string' || !payload.title.trim()) {
          throw new Error('CREATE_GOAL requires payload.title');
        }
        if (typeof payload.category !== 'string') {
          throw new Error('CREATE_GOAL requires payload.category');
        }
        if (typeof payload.targetHours !== 'number') {
          throw new Error('CREATE_GOAL requires numeric payload.targetHours');
        }
        const created = await this.goals.create(userId, payload as any);
        return created?.id;
      }
      case 'DELETE_GOAL': {
        if (!action.id) throw new Error('DELETE_GOAL requires id');
        await this.deleteIdempotent(() => this.goals.delete(userId, action.id!));
        return action.id;
      }

      // -------- Schedule blocks --------
      case 'CREATE_SCHEDULE_BLOCK': {
        const p = { ...(payload as any) };
        // Multi-day support: the model may pass daysOfWeek:number[] to create
        // the same block across several days in ONE action, as a recurring
        // series sharing a seriesId. This is how a whole week fits in ~13
        // actions instead of ~90 — which is what keeps the model from
        // truncating the proposal or tripping the provider's rate limit.
        const rawDays: unknown = p.daysOfWeek;
        delete p.daysOfWeek;
        const days = Array.isArray(rawDays)
          ? Array.from(
              new Set(
                rawDays.filter(
                  (d): d is number =>
                    Number.isInteger(d) && d >= 0 && d <= 6,
                ),
              ),
            )
          : typeof p.dayOfWeek === 'number'
            ? [p.dayOfWeek]
            : [];

        if (days.length <= 1) {
          if (days.length === 1) p.dayOfWeek = days[0];
          return this.createBlockIdempotent(userId, p);
        }

        // One shared series across the requested days. Best-effort per day: a
        // day that already has a genuinely conflicting (non-identical) block is
        // skipped rather than failing the whole week. Return the first block id
        // so a later $ref can still resolve.
        const seriesId = randomUUID();
        let firstId: string | undefined;
        for (const d of days) {
          try {
            const id = await this.createBlockIdempotent(userId, {
              ...p,
              dayOfWeek: d,
              seriesId,
              isRecurring: true,
            });
            if (!firstId) firstId = id;
          } catch (err) {
            if (err instanceof BadRequestException) continue;
            throw err;
          }
        }
        return firstId;
      }
      case 'UPDATE_SCHEDULE_BLOCK': {
        if (!action.id) throw new Error('UPDATE_SCHEDULE_BLOCK requires id');
        const expectedTitle = action.expectedTitle;

        // Defense in depth against the id resolving but to the WRONG block: a
        // live bug had the model target ids on days that matched the requested
        // day range but whose title had nothing to do with the block the user
        // named (e.g. asking to edit "Dinner, Arabic and Family time" also
        // touched an unrelated "LeafCompute" block that happened to sit on one
        // of the requested days). If the Coach told us what title it expects,
        // verify the id actually points at that block BEFORE writing anything.
        // Silently no-ops if the id doesn't resolve at all - that case is
        // staleness, handled below, not a wrong-block problem.
        if (expectedTitle) {
          await this.assertExpectedTitle(userId, action.id, expectedTitle);
        }

        try {
          const updated = await this.schedule.update(userId, action.id, payload as any);
          return (updated as any)?.id ?? action.id;
        } catch (err) {
          if (!(err instanceof NotFoundException)) throw err;
          // The id the Coach was given has gone stale. schedule.service.ts never
          // changes a block's id on a plain edit (single or series-scoped update
          // both do an in-place `update`), so this can only mean the row itself
          // is gone: most likely a proposal card sitting in chat history was
          // generated on an earlier turn, and the block behind that id was
          // deleted (and possibly recreated under a new id) outside the chat
          // before the user clicked Apply. Rather than surface the bare "not
          // found", try to re-resolve the same logical block from the CURRENT
          // schedule using whatever identifying info is available. Deliberately
          // strict: title matching here is exact (modulo case/whitespace), never
          // fuzzy or substring, and dayOfWeek is never used on its own - the
          // live wrong-block bug above is exactly what loose matching produces.
          const resolution = await this.resolveStaleScheduleBlock(
            userId,
            payload as any,
            expectedTitle,
          );
          if (resolution.status !== 'resolved') {
            throw new NotFoundException(
              this.describeUpdateFailure(
                payload as any,
                resolution.status,
                expectedTitle,
              ),
            );
          }
          // Belt and suspenders: the resolution tiers that don't key off title
          // (goalId, or day + overlapping window) could in principle land on a
          // block whose title still doesn't match what the Coach expected.
          // Re-check before applying so a weak tier can never silently edit the
          // wrong block just because expectedTitle wasn't part of that tier.
          if (expectedTitle) {
            await this.assertExpectedTitle(userId, resolution.id, expectedTitle);
          }
          const updated = await this.schedule.update(
            userId,
            resolution.id,
            payload as any,
          );
          return (updated as any)?.id ?? resolution.id;
        }
      }
      case 'DELETE_SCHEDULE_BLOCK': {
        if (!action.id) throw new Error('DELETE_SCHEDULE_BLOCK requires id');
        // Idempotent delete: a block that's already gone is the desired end
        // state, not a failure. The model sometimes proposes deletes for
        // blocks that never existed (hallucinated ids on a fresh schedule);
        // swallowing not-found keeps those from failing the whole batch.
        await this.deleteIdempotent(() =>
          this.schedule.delete(userId, action.id!),
        );
        return action.id;
      }

      // -------- Time entries --------
      case 'CREATE_TIME_ENTRY': {
        const created = await this.timeEntries.create(userId, payload as any);
        return (created as any)?.id;
      }
      case 'UPDATE_TIME_ENTRY': {
        if (!action.id) throw new Error('UPDATE_TIME_ENTRY requires id');
        const updated = await this.timeEntries.update(
          userId,
          action.id,
          payload as any,
        );
        return (updated as any)?.id ?? action.id;
      }
      case 'DELETE_TIME_ENTRY': {
        if (!action.id) throw new Error('DELETE_TIME_ENTRY requires id');
        await this.deleteIdempotent(() =>
          this.timeEntries.delete(userId, action.id!),
        );
        return action.id;
      }

      // -------- Tasks --------
      case 'CREATE_TASK': {
        const created = await this.tasks.create(userId, payload as any);
        return (created as any)?.id;
      }
      case 'UPDATE_TASK': {
        if (!action.id) throw new Error('UPDATE_TASK requires id');
        const updated = await this.tasks.update(userId, action.id, payload as any);
        return (updated as any)?.id ?? action.id;
      }
      case 'DELETE_TASK': {
        if (!action.id) throw new Error('DELETE_TASK requires id');
        await this.deleteIdempotent(() => this.tasks.delete(userId, action.id!));
        return action.id;
      }

      // -------- Active practice (CoachInsight in ACCEPTED) --------
      case 'CREATE_PRACTICE': {
        const created = await this.insights.createAccepted(userId, payload as any);
        return created.id;
      }

      default:
        throw new Error(`Unknown action type: ${(action as any).type}`);
    }
  }

  /**
   * Create a schedule block, or return an existing identical one (same day +
   * start + end + title) so re-applying a proposal never duplicates or errors
   * on a self-conflict. Shared by the single-day and multi-day create paths.
   */
  private async createBlockIdempotent(
    userId: string,
    p: any,
  ): Promise<string | undefined> {
    if (
      p &&
      typeof p.title === 'string' &&
      typeof p.dayOfWeek === 'number' &&
      typeof p.startTime === 'string' &&
      typeof p.endTime === 'string'
    ) {
      const existing = await this.prisma.scheduleBlock.findFirst({
        where: {
          userId,
          dayOfWeek: p.dayOfWeek,
          startTime: p.startTime,
          endTime: p.endTime,
          title: p.title,
        },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    const created = await this.schedule.create(userId, p);
    return (created as any)?.id;
  }

  /**
   * Run a delete, treating "not found" as success. Deleting something that is
   * already gone reaches the same end state the user approved, so it should not
   * fail the action (and take the rest of a batch's reporting down with noise).
   */
  private async deleteIdempotent(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof NotFoundException) return;
      // Prisma "record to delete does not exist" also means already-gone.
      if ((err as { code?: string })?.code === 'P2025') return;
      throw err;
    }
  }

  /**
   * Guard against an UPDATE_SCHEDULE_BLOCK id that resolves but to the WRONG
   * block - the id exists and belongs to this user, but its current title
   * doesn't match what the Coach said it expects. This is what a live bug
   * looked like: a batch request to edit a named block across several days
   * also touched unrelated blocks that merely happened to sit on one of the
   * requested days (an id chosen at proposal-generation time, not a stale-id
   * problem - schedule.update() would have succeeded on it).
   *
   * Intentionally strict: exact match only (case/whitespace-normalized), never
   * substring or fuzzy. No-ops if the id doesn't resolve at all - that's
   * staleness, reported by the normal not-found path, not a wrong-block one.
   */
  private async assertExpectedTitle(
    userId: string,
    blockId: string,
    expectedTitle: string,
  ): Promise<void> {
    const block = await this.prisma.scheduleBlock.findFirst({
      where: { id: blockId, userId },
      select: { title: true },
    });
    if (!block) return;
    if (!titlesMatch(block.title, expectedTitle)) {
      throw new BadRequestException(
        `Skipped updating "${block.title}": this action targeted a different block than intended ` +
          `("${expectedTitle}"). Nothing was changed on it. Check your current schedule and ask again, ` +
          'naming the block exactly.',
      );
    }
  }

  /**
   * Re-resolve a schedule block whose id has gone stale (see UPDATE_SCHEDULE_BLOCK
   * above) by matching identifying fields against the user's CURRENT schedule.
   * There is no history/audit trail for schedule blocks (AuditLog exists in the
   * schema but nothing writes to it for schedule blocks), so this can only work
   * with the block's expected title (if the Coach supplied one) and whatever
   * else the update payload itself carries. A plain "change the time" action
   * with no expectedTitle carries nothing that safely identifies which of the
   * user's blocks it meant - that case intentionally falls through to
   * "no-match" rather than guessing.
   *
   * Match tiers below, strongest first. The first tier that has any hits
   * decides the outcome: exactly one hit resolves, more than one is treated as
   * unresolvable (a false match that edits the wrong block is worse than a
   * clear failure), and zero hits falls through to the next, weaker tier. Title
   * comparisons are always exact (case/whitespace-normalized) - never fuzzy or
   * substring - and dayOfWeek is never used as a match key on its own, only
   * combined with title, goalId, or an overlapping time window. payload.title
   * is deliberately NOT used here: it means "rename to this", not "this is the
   * current title", so using it for identity would be ambiguous with a genuine
   * rename request.
   */
  private async resolveStaleScheduleBlock(
    userId: string,
    payload: Record<string, any>,
    expectedTitle: string | undefined,
  ): Promise<
    | { status: 'resolved'; id: string }
    | { status: 'ambiguous' }
    | { status: 'no-match' }
  > {
    const title =
      typeof expectedTitle === 'string' && expectedTitle.trim()
        ? normalizeTitle(expectedTitle)
        : undefined;
    const dayOfWeek =
      typeof payload.dayOfWeek === 'number' ? payload.dayOfWeek : undefined;
    const goalId =
      typeof payload.goalId === 'string' && payload.goalId
        ? payload.goalId
        : undefined;
    const hasWindow =
      typeof payload.startTime === 'string' &&
      typeof payload.endTime === 'string';

    if (title === undefined && dayOfWeek === undefined && goalId === undefined) {
      // Nothing identifies the block beyond its (now dead) id.
      return { status: 'no-match' };
    }

    const blocks = await this.prisma.scheduleBlock.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        goalId: true,
      },
    });

    const tiers: Array<(b: (typeof blocks)[number]) => boolean> = [];

    if (title !== undefined && dayOfWeek !== undefined) {
      tiers.push(
        (b) => b.dayOfWeek === dayOfWeek && normalizeTitle(b.title) === title,
      );
    }
    if (title !== undefined) {
      tiers.push((b) => normalizeTitle(b.title) === title);
    }
    if (dayOfWeek !== undefined && goalId !== undefined) {
      tiers.push((b) => b.dayOfWeek === dayOfWeek && b.goalId === goalId);
    }
    if (dayOfWeek !== undefined && hasWindow) {
      tiers.push(
        (b) =>
          b.dayOfWeek === dayOfWeek &&
          windowsOverlap(
            b.startTime,
            b.endTime,
            payload.startTime,
            payload.endTime,
          ),
      );
    }
    if (goalId !== undefined) {
      tiers.push((b) => b.goalId === goalId);
    }

    for (const tier of tiers) {
      const matches = blocks.filter(tier);
      if (matches.length === 1) return { status: 'resolved', id: matches[0].id };
      if (matches.length > 1) return { status: 'ambiguous' };
    }

    return { status: 'no-match' };
  }

  /**
   * Build a specific, per-action failure message for an UPDATE_SCHEDULE_BLOCK
   * whose id could not be resolved, so a batch of several stale updates shows
   * distinct, useful lines instead of four identical "Schedule block not found".
   */
  private describeUpdateFailure(
    payload: Record<string, any>,
    reason: 'ambiguous' | 'no-match',
    expectedTitle: string | undefined,
  ): string {
    const bits: string[] = [];
    if (expectedTitle) {
      bits.push(`"${expectedTitle}"`);
    }
    if (typeof payload.startTime === 'string' && typeof payload.endTime === 'string') {
      bits.push(`its time to ${payload.startTime}-${payload.endTime}`);
    } else if (typeof payload.startTime === 'string') {
      bits.push(`its start time to ${payload.startTime}`);
    } else if (typeof payload.endTime === 'string') {
      bits.push(`its end time to ${payload.endTime}`);
    }
    if (typeof payload.dayOfWeek === 'number') {
      bits.push(`its day to ${DAY_NAMES[payload.dayOfWeek] ?? payload.dayOfWeek}`);
    }
    if (typeof payload.title === 'string') {
      bits.push(`its title to "${payload.title}"`);
    }
    if (typeof payload.goalId === 'string') {
      bits.push('its linked goal');
    }
    const change = bits.length ? bits.join(', ') : 'this schedule block';

    if (reason === 'ambiguous') {
      return (
        `Could not update ${change}: multiple blocks in your current schedule could match, ` +
        'so nothing was changed to avoid editing the wrong one. Check your current schedule ' +
        'and ask again, naming the block more specifically.'
      );
    }
    return (
      `Could not update ${change}: this schedule block no longer exists in your current ` +
      'schedule (it may have been edited or recreated since this suggestion was made). ' +
      'Check your current schedule and ask again.'
    );
  }
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Normalize a title for comparison: trim, lowercase, collapse internal
 * whitespace runs to a single space. Deliberately NOT a fuzzy/substring match
 * - "Family Time" and "Dinner, Arabic and Family time" must stay distinct.
 */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function titlesMatch(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function windowsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const s1 = timeToMinutes(aStart);
  const e1 = timeToMinutes(aEnd);
  const s2 = timeToMinutes(bStart);
  const e2 = timeToMinutes(bEnd);
  return s1 < e2 && e1 > s2;
}

/**
 * Replace any `"$ref:N"` strings in the payload with the resultId of the
 * action at batch index N. Walks objects + arrays recursively. Used so the
 * Coach can express dependencies inside a single approval batch.
 */
function resolveRefs(
  value: any,
  results: CoachActionResult[],
): any {
  if (typeof value === 'string') {
    const m = /^\$ref:(\d+)$/.exec(value);
    if (m) {
      const idx = Number(m[1]);
      const ref = results[idx];
      if (!ref?.ok || !ref.resultId) {
        throw new Error(
          `Cannot resolve $ref:${idx}: prior action did not succeed or has no resultId`,
        );
      }
      return ref.resultId;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = resolveRefs(value[k], results);
    return out;
  }
  return value;
}
