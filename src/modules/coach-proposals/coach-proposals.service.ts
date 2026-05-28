import { Injectable, Logger } from '@nestjs/common';
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
        await this.goals.delete(userId, action.id);
        return action.id;
      }

      // -------- Schedule blocks --------
      case 'CREATE_SCHEDULE_BLOCK': {
        const created = await this.schedule.create(userId, payload as any);
        return (created as any)?.id;
      }
      case 'UPDATE_SCHEDULE_BLOCK': {
        if (!action.id) throw new Error('UPDATE_SCHEDULE_BLOCK requires id');
        const updated = await this.schedule.update(userId, action.id, payload as any);
        return (updated as any)?.id ?? action.id;
      }
      case 'DELETE_SCHEDULE_BLOCK': {
        if (!action.id) throw new Error('DELETE_SCHEDULE_BLOCK requires id');
        await this.schedule.delete(userId, action.id);
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
        await this.timeEntries.delete(userId, action.id);
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
        await this.tasks.delete(userId, action.id);
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
