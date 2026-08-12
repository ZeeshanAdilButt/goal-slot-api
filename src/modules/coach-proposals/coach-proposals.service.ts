import {
  BadRequestException,
  ConflictException,
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
import { ActiveTimerService } from '../active-timer/active-timer.service';
import { ACTIVE_SESSION_EXISTS } from '../active-timer/active-timer.constants';
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
    private readonly activeTimer: ActiveTimerService,
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
        const { resultId, warning } = await this.dispatch(userId, action);
        results.push({
          index: i,
          type: action.type,
          ok: true,
          resultId,
          ...(warning ? { warning } : {}),
        });
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

  /**
   * `warning` is set on an otherwise-successful action whose effect isn't
   * exactly what was asked for — currently just STOP_TIMER hitting the
   * 12-hour session cap. `resultId` stays optional/undefined for actions
   * that don't produce one, matching the previous `string | undefined`
   * contract this replaces.
   */
  private async dispatch(
    userId: string,
    action: CoachProposedAction,
  ): Promise<{ resultId?: string; warning?: string }> {
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
        return { resultId: updated?.id };
      }
      case 'UPDATE_GOAL': {
        if (!action.id) throw new Error('UPDATE_GOAL requires id');
        const updated = await this.goals.update(userId, action.id, payload as any);
        return { resultId: updated?.id };
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
        return { resultId: created?.id };
      }
      case 'DELETE_GOAL': {
        if (!action.id) throw new Error('DELETE_GOAL requires id');
        await this.deleteIdempotent(() => this.goals.delete(userId, action.id!));
        return { resultId: action.id };
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
          return { resultId: await this.createBlockIdempotent(userId, p) };
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
        return { resultId: firstId };
      }
      case 'UPDATE_SCHEDULE_BLOCK': {
        if (!action.id) throw new Error('UPDATE_SCHEDULE_BLOCK requires id');
        const updated = await this.schedule.update(userId, action.id, payload as any);
        return { resultId: (updated as any)?.id ?? action.id };
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
        return { resultId: action.id };
      }

      // -------- Time entries --------
      case 'CREATE_TIME_ENTRY': {
        const created = await this.timeEntries.create(userId, payload as any);
        return { resultId: (created as any)?.id };
      }
      case 'UPDATE_TIME_ENTRY': {
        if (!action.id) throw new Error('UPDATE_TIME_ENTRY requires id');
        const updated = await this.timeEntries.update(
          userId,
          action.id,
          payload as any,
        );
        return { resultId: (updated as any)?.id ?? action.id };
      }
      case 'DELETE_TIME_ENTRY': {
        if (!action.id) throw new Error('DELETE_TIME_ENTRY requires id');
        await this.deleteIdempotent(() =>
          this.timeEntries.delete(userId, action.id!),
        );
        return { resultId: action.id };
      }

      // -------- Tasks --------
      case 'CREATE_TASK': {
        const created = await this.tasks.create(userId, payload as any);
        return { resultId: (created as any)?.id };
      }
      case 'UPDATE_TASK': {
        if (!action.id) throw new Error('UPDATE_TASK requires id');
        const updated = await this.tasks.update(userId, action.id, payload as any);
        return { resultId: (updated as any)?.id ?? action.id };
      }
      case 'DELETE_TASK': {
        if (!action.id) throw new Error('DELETE_TASK requires id');
        await this.deleteIdempotent(() => this.tasks.delete(userId, action.id!));
        return { resultId: action.id };
      }

      // -------- Active practice (CoachInsight in ACCEPTED) --------
      case 'CREATE_PRACTICE': {
        const created = await this.insights.createAccepted(userId, payload as any);
        return { resultId: created.id };
      }

      // -------- Live timer (ActiveTimerSession) --------
      /*
       * WHY THE COACH NEVER SENDS `takeOver: true`.
       *
       * `takeOver` DISCARDS the session it replaces — no TimeEntry is
       * written, the elapsed time is gone (see ActiveTimerService.start).
       * Three reasons that can never be an automatic choice here:
       *
       *  1. The model decides at compose time; the user clicks apply later.
       *     The proposal is built from a context bundle with no live session
       *     in it, and minutes can pass before the click — long enough for a
       *     timer to be started on another device. A `takeOver` the model
       *     chose is a decision made without the fact it depends on.
       *  2. The cost is asymmetric and irreversible. Refusing costs one extra
       *     sentence; taking over costs however long the other device had
       *     been running, unrecoverably. A 40-minute deep-work session
       *     vanishing because the user said "start tracking my deen goal" is
       *     a data-loss bug wearing a feature's clothes.
       *  3. It would defeat the point of #72's 409, which exists so the
       *     person — seeing what is actually running — makes the call.
       *
       * So START_TIMER always takes the reject path, `takeOver` is dropped
       * even when the model puts it in the payload, and the 409 is rewritten
       * into a sentence the user reads on the approval card. Switching
       * timers is then an explicit STOP_TIMER + START_TIMER they approve
       * with their eyes open.
       */
      case 'START_TIMER': {
        const goalId = await this.resolveGoalId(userId, payload);

        let session;
        try {
          session = await this.activeTimer.start(userId, {
            taskName: coerceLabel(payload.taskName),
            notes: coerceLabel(payload.notes),
            goalId,
            taskId: coerceId(payload.taskId),
            scheduleBlockId: coerceId(payload.scheduleBlockId),
          });
        } catch (err) {
          throw this.humanizeStartConflict(err);
        }
        return { resultId: session.id };
      }
      case 'STOP_TIMER': {
        // Attribution here is an override applied at stop time — this is the
        // "you started a bare timer, now say what it was for" path. Omitted
        // fields keep whatever the session already carries.
        const goalId = await this.resolveGoalId(userId, payload);

        let stopped;
        try {
          stopped = await this.activeTimer.stop(userId, {
            ...(payload.taskName !== undefined
              ? { taskName: coerceLabel(payload.taskName) }
              : {}),
            ...(payload.notes !== undefined
              ? { notes: coerceLabel(payload.notes) }
              : {}),
            ...(goalId !== undefined ? { goalId } : {}),
            ...(payload.taskId !== undefined
              ? { taskId: coerceId(payload.taskId) }
              : {}),
            ...(payload.scheduleBlockId !== undefined
              ? { scheduleBlockId: coerceId(payload.scheduleBlockId) }
              : {}),
          });
        } catch (err) {
          // NOT idempotent-on-not-found, unlike the DELETE_* actions above.
          // "Already deleted" reaches the end state the user approved, but
          // "nothing was running" means no time was logged at all — reporting
          // that as ok:true would have the Coach tell the user their session
          // was saved when nothing was written.
          if (err instanceof NotFoundException) {
            throw new Error(
              'No timer is running, so there was nothing to stop. Nothing was logged.',
            );
          }
          throw err;
        }

        const resultId = (stopped as any)?.timeEntry?.id;
        // A 14-hour tracked session stopped via the Coach must not silently
        // write 12 hours and report plain success — see MAX_SESSION_MS in
        // active-timer.constants.ts. `capped`/`maxSessionMs` are already on
        // stop()'s return shape; this is the one caller that previously
        // discarded both.
        if ((stopped as any)?.capped) {
          const maxHours = Math.round((stopped as any).maxSessionMs / 3_600_000);
          return {
            resultId,
            warning: `Session exceeded the ${maxHours} hour tracking limit; only the first ${maxHours} hours were saved.`,
          };
        }
        return { resultId };
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
   * Work out which goal a timer action is about.
   *
   * Every other action in this service takes an id straight from the model,
   * because the prompt hands it "This week's context" with `id=<goalId> |
   * "<title>"` lines and tells it to copy them verbatim (see UPDATE_GOAL).
   * That stays the primary path here: an explicit `goalId` is passed through
   * untouched and ownership is enforced downstream, exactly like everywhere
   * else.
   *
   * The extra path exists because this is the action a voice assistant will
   * drive. "Start tracking time for my deen goal" is a spoken NAME, and a
   * transcribed request that never went near the context block is far more
   * likely to arrive as a name than as a uuid — so `goalName` is resolved
   * against the user's own goals here.
   *
   * Two failure modes, handled differently on purpose:
   *   - `goalName` given but unresolvable (or ambiguous) -> throw. The model
   *     promised the user their deen time would be tracked; starting an
   *     unattributed timer instead is a silent lie that only surfaces days
   *     later as untracked hours.
   *   - `taskName` (a free-text label, not a goal reference) that happens to
   *     name a goal -> best-effort only. An unambiguous hit attaches the
   *     goal, anything else just leaves the timer unattributed. A label was
   *     never a promise about attribution, so it must not fail the action.
   */
  private async resolveGoalId(
    userId: string,
    payload: Record<string, any>,
  ): Promise<string | undefined> {
    const explicitId = coerceId(payload.goalId);
    if (explicitId) return explicitId;

    // An explicit name is a promise to the user; a label is only a guess.
    // `mustResolve` is what keeps those two apart below.
    const named = coerceLabel(payload.goalName) ?? coerceLabel(payload.goalTitle);
    const query = named ?? coerceLabel(payload.taskName);
    if (!query) return undefined;
    const mustResolve = !!named;

    const goals = await this.prisma.goal.findMany({
      where: { userId },
      select: { id: true, title: true, status: true },
    });

    const matches = matchGoalsByName(goals, query);
    if (matches.length === 1) return matches[0].id;

    if (matches.length > 1) {
      // Prefer the single ACTIVE candidate: "my deen goal" means the one the
      // user is currently working, not a completed namesake from last year.
      const active = matches.filter((g) => g.status === 'ACTIVE');
      if (active.length === 1) return active[0].id;
      if (mustResolve) {
        const titles = matches.map((g) => `"${g.title}"`).join(', ');
        throw new Error(
          `More than one goal matches "${query}" (${titles}). Ask which one before starting the timer.`,
        );
      }
      return undefined;
    }

    if (mustResolve) {
      throw new Error(
        `No goal matching "${query}". Create the goal first, or start the timer without one and attach it later.`,
      );
    }
    return undefined;
  }

  /**
   * Turn the active-timer 409 into something the user can act on.
   *
   * The raw message ends with "retry with takeOver: true", which is fine for
   * a client that can prompt but wrong here: this string is rendered straight
   * onto the approval card as the reason the action failed, so it has to read
   * as an explanation to a person, not an instruction to a developer.
   */
  private humanizeStartConflict(err: unknown): unknown {
    if (!(err instanceof ConflictException)) return err;
    const body = err.getResponse() as {
      code?: string;
      activeSession?: {
        elapsedMs?: number;
        taskName?: string | null;
        goal?: { title?: string } | null;
      } | null;
    };
    if (body?.code !== ACTIVE_SESSION_EXISTS) return err;

    const session = body.activeSession;
    const what = session?.goal?.title ?? session?.taskName ?? null;
    const label = what ? `"${what}"` : 'a timer';
    const since = formatSince(session?.elapsedMs);

    return new Error(
      `You are already tracking ${label}${since}. That timer is still running and untouched. ` +
        'Stop it first if you want to switch, or just let it keep going.',
    );
  }
}

/** Trim a free-text field; empty/blank and non-strings become undefined. */
function coerceLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

/** Same, for id fields — keeps `null` and `""` from reaching the DTO's @IsUUID. */
function coerceId(value: unknown): string | undefined {
  return coerceLabel(value);
}

/**
 * Case-insensitive goal lookup by spoken name.
 *
 * Exact title wins outright, so a goal literally called "Deen" is never
 * ambiguous against "Deen reading". Otherwise it is a containment match in
 * either direction: the user says "deen" for "Deen reading (daily)", and
 * equally says "my deen reading goal" for "Deen reading".
 */
function matchGoalsByName<T extends { title: string }>(goals: T[], query: string): T[] {
  const needle = normalizeTitle(query);
  if (!needle) return [];

  const exact = goals.filter((g) => normalizeTitle(g.title) === needle);
  if (exact.length) return exact;

  return goals.filter((g) => {
    const title = normalizeTitle(g.title);
    return title.includes(needle) || needle.includes(title);
  });
}

/**
 * Lowercase, strip punctuation, collapse whitespace, and drop the filler
 * words a spoken request carries. "my Deen goal" and "Deen" must land on the
 * same key or voice input misses on wording alone.
 */
function normalizeTitle(value: string): string {
  const stripped = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w))
    .join(' ');
  return stripped.trim();
}

const FILLER_WORDS = new Set([
  'my',
  'the',
  'a',
  'an',
  'goal',
  'goals',
  'for',
  'on',
  'to',
]);

/** " (running for 12 minutes)" — omitted when elapsed is unknown or under a minute. */
function formatSince(elapsedMs: unknown): string {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return '';
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return '';
  if (minutes < 60) {
    return ` (running for ${minutes} minute${minutes === 1 ? '' : 's'})`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursPart = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest
    ? ` (running for ${hoursPart} ${rest} minute${rest === 1 ? '' : 's'})`
    : ` (running for ${hoursPart})`;
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
