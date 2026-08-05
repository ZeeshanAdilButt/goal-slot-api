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
  ): Promise<CoachActionResult[]> {
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
        const updated = await this.schedule.update(userId, action.id, payload as any);
        return (updated as any)?.id ?? action.id;
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
