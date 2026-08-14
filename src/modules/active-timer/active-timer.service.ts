import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { GoalsService } from '../goals/goals.service';
import {
  StartTimerSessionDto,
  StopTimerSessionDto,
  UpdateTimerSessionDto,
} from './dto/active-timer.dto';
import {
  ACTIVE_SESSION_ALREADY_STOPPED,
  ACTIVE_SESSION_EXISTS,
  DEFAULT_TASK_NAME,
  MAX_ACCUMULATED_MS,
  MAX_SESSION_MS,
  STALE_AFTER_MS,
} from './active-timer.constants';

type SessionRow = {
  id: string;
  userId: string;
  status: 'RUNNING' | 'PAUSED';
  startedAt: Date;
  segmentStartedAt: Date | null;
  pausedAt: Date | null;
  accumulatedMs: number;
  taskName: string | null;
  notes: string | null;
  goalId: string | null;
  taskId: string | null;
  scheduleBlockId: string | null;
  lastClient: string | null;
  createdAt: Date;
  updatedAt: Date;
  goal?: { id: string; title: string; color: string } | null;
  task?: { id: string; title: string } | null;
  scheduleBlock?: { id: string; title: string } | null;
};

const ATTRIBUTION_INCLUDE = {
  goal: { select: { id: true, title: true, color: true } },
  task: { select: { id: true, title: true } },
  scheduleBlock: { select: { id: true, title: true } },
} as const;

/**
 * Reconstructs elapsed time from the stored facts. Pure, so it is correct
 * whether it runs one second or one week after the last write, and it composes
 * over any number of pause/resume cycles: each completed segment has already
 * been folded into `accumulatedMs`, and at most one segment is ever open.
 *
 * Mirrors the mobile client's local `getElapsedMs`, deliberately — the two
 * must agree or the clock jumps when a device syncs.
 */
export function computeElapsedMs(
  session: Pick<SessionRow, 'status' | 'segmentStartedAt' | 'accumulatedMs'>,
  now: Date = new Date(),
): number {
  if (session.status === 'RUNNING' && session.segmentStartedAt) {
    const open = now.getTime() - session.segmentStartedAt.getTime();
    // Clamped at 0: a client clock ahead of the server would otherwise make
    // the open segment negative and the whole session appear to run backwards.
    return session.accumulatedMs + Math.max(0, open);
  }
  return session.accumulatedMs;
}

/**
 * Milliseconds -> whole minutes for `TimeEntry.duration`.
 *
 * Nearest minute, with a floor of 1. Truncating would turn a 30-second
 * session into a 0-minute entry, which reads to the user as "the app lost my
 * work" and is also rejected by CreateTimeEntryDto's own `@Min(1)`. Rounding
 * up everything would inflate long sessions. Nearest-with-a-floor keeps long
 * sessions honest and guarantees that stopping a timer always produces
 * something visible.
 */
export function toDurationMinutes(elapsedMs: number): number {
  return Math.max(1, Math.round(elapsedMs / 60_000));
}

/**
 * Normalizes an instant to `TimeEntry.date`'s expected shape: UTC-midnight of
 * a calendar date, matching TimeEntriesService.create's handling of a
 * client-supplied `dto.date` string (`new Date(dto.date)`, e.g.
 * `new Date('2026-08-13')`).
 *
 * There is no per-user timezone tracked anywhere in this codebase (see the
 * User model in prisma/schema.prisma) — on the manual-entry path the client
 * decides what "today" means and just sends a date string, and the server
 * trusts it. `stop()` has no client-supplied string to trust, so this uses
 * the server process's own local calendar fields as the best available
 * stand-in for "today", which is the same gap the rest of the app already
 * has, not a new one.
 *
 * `dayOfWeek` should be read off this date's UTC calendar fields
 * (`date.getUTCDay()`), not `date.getDay()`. Every reader of `date` treats
 * `date.toISOString().split('T')[0]` as the canonical calendar-date string
 * (see reports.service.ts), and only the UTC day-of-week is guaranteed to
 * agree with that string on a server whose local TZ isn't UTC — `.getDay()`
 * reinterprets the UTC-midnight instant in local time and can walk it onto
 * the adjacent calendar day, which is exactly how `date` and `dayOfWeek`
 * ended up disagreeing on the same row before this fix.
 */
export function toLocalDateOnly(instant: Date): Date {
  const year = instant.getFullYear();
  const month = String(instant.getMonth() + 1).padStart(2, '0');
  const day = String(instant.getDate()).padStart(2, '0');
  return new Date(`${year}-${month}-${day}`);
}

@Injectable()
export class ActiveTimerService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private goalsService: GoalsService,
  ) {}

  async getActive(userId: string) {
    const session = await this.findRow(userId);
    return session ? this.toResponse(session) : null;
  }

  /**
   * Conflict rule: a second start while a session is already running is a
   * 409, not a silent takeover.
   *
   * Silently replacing would destroy however long the other device had been
   * tracking, with no way to get it back and no signal that it happened —
   * the user opens their laptop later and 40 minutes of work is simply gone.
   * A 409 hands the decision back to the user, and because the response body
   * carries the full current session the client can render the choice
   * ("Resume here / Stop it and start fresh / Cancel") without a second
   * round trip. Clients that already asked the user send `takeOver: true`.
   *
   * Enforcement is the unique index on `userId`, not a read-then-write: two
   * devices hitting start in the same millisecond both attempt the insert,
   * one gets P2002, and that is translated into the same 409.
   */
  async start(userId: string, dto: StartTimerSessionDto) {
    await this.assertAttributionOwned(userId, dto);

    const now = new Date();
    const base = {
      status: 'RUNNING' as const,
      startedAt: now,
      segmentStartedAt: now,
      pausedAt: null,
      accumulatedMs: 0,
      taskName: dto.taskName ?? null,
      notes: dto.notes ?? null,
      goalId: dto.goalId ?? null,
      taskId: dto.taskId ?? null,
      scheduleBlockId: dto.scheduleBlockId ?? null,
      lastClient: dto.client ?? null,
    };

    // Gate the plan's daily-entry limit here rather than on stop. Failing at
    // start costs the user nothing; failing at stop would strand a session
    // holding real elapsed time with no way to save it.
    await this.assertDailyEntryHeadroom(userId, now);

    if (dto.takeOver) {
      // Upsert on the unique userId, so the takeover is itself atomic: the
      // row is replaced in one statement rather than delete-then-insert with
      // a window where the user has no session at all.
      const session = await this.prisma.activeTimerSession.upsert({
        where: { userId },
        create: { userId, ...base },
        update: base,
        include: ATTRIBUTION_INCLUDE,
      });
      return this.toResponse(session as SessionRow);
    }

    try {
      const session = await this.prisma.activeTimerSession.create({
        data: { userId, ...base },
        include: ATTRIBUTION_INCLUDE,
      });
      return this.toResponse(session as SessionRow);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const current = await this.findRow(userId);
      throw new ConflictException({
        code: ACTIVE_SESSION_EXISTS,
        message:
          'A timer is already running for this account. Stop it, resume it, or retry with takeOver: true.',
        activeSession: current ? this.toResponse(current) : null,
      });
    }
  }

  /**
   * Idempotent by design. Two devices can both hit pause on the same session;
   * without the compare-and-set the second call would fold the already-closed
   * segment into `accumulatedMs` a second time and double-count it.
   */
  async pause(userId: string) {
    const session = await this.requireRow(userId);
    if (session.status === 'PAUSED') return this.toResponse(session);

    const now = new Date();
    const openMs = session.segmentStartedAt
      ? Math.max(0, now.getTime() - session.segmentStartedAt.getTime())
      : 0;
    const accumulatedMs = Math.min(
      session.accumulatedMs + openMs,
      MAX_ACCUMULATED_MS,
    );

    const { count } = await this.prisma.activeTimerSession.updateMany({
      where: { id: session.id, userId, status: 'RUNNING' },
      data: {
        status: 'PAUSED',
        segmentStartedAt: null,
        pausedAt: now,
        accumulatedMs,
      },
    });

    // count === 0 means another request paused (or stopped) it between our
    // read and our write. Re-read rather than guess.
    if (count === 0) return this.getActive(userId);
    return this.toResponse(await this.requireRow(userId));
  }

  /** Idempotent for the same reason as pause: resuming twice must not reopen two segments. */
  async resume(userId: string) {
    const session = await this.requireRow(userId);
    if (session.status === 'RUNNING') return this.toResponse(session);

    const now = new Date();
    const { count } = await this.prisma.activeTimerSession.updateMany({
      where: { id: session.id, userId, status: 'PAUSED' },
      data: { status: 'RUNNING', segmentStartedAt: now, pausedAt: null },
    });

    if (count === 0) return this.getActive(userId);
    return this.toResponse(await this.requireRow(userId));
  }

  /**
   * Attach or detach attribution on a running session. This is what the
   * clients call when the user picks a goal after having already started.
   *
   * Omitting a field leaves it alone; sending it as `null` clears it.
   * Elapsed-time state is untouched — changing attribution must never move
   * the clock.
   */
  async updateAttribution(userId: string, dto: UpdateTimerSessionDto) {
    const session = await this.requireRow(userId);
    await this.assertAttributionOwned(userId, dto);

    const data: Prisma.ActiveTimerSessionUncheckedUpdateInput = {};
    if (dto.taskName !== undefined) data.taskName = dto.taskName;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.goalId !== undefined) data.goalId = dto.goalId;
    if (dto.taskId !== undefined) data.taskId = dto.taskId;
    if (dto.scheduleBlockId !== undefined)
      data.scheduleBlockId = dto.scheduleBlockId;
    if (dto.client !== undefined) data.lastClient = dto.client;

    if (Object.keys(data).length === 0) return this.toResponse(session);

    const updated = await this.prisma.activeTimerSession.update({
      where: { id: session.id },
      data,
      include: ATTRIBUTION_INCLUDE,
    });
    return this.toResponse(updated as SessionRow);
  }

  /**
   * Convert the session into a real TimeEntry and clear it, atomically.
   *
   * The delete runs FIRST inside the transaction and its row count is
   * checked. That is what makes a double-stop safe: two concurrent requests
   * both try to delete the same row, Postgres serialises them, the loser sees
   * `count === 0` and aborts the whole transaction — so it writes no second
   * TimeEntry. And because the create shares the transaction, the reverse
   * failure (session gone, no entry written) cannot happen either: if the
   * insert fails, the delete rolls back with it and the session is still
   * there to retry.
   */
  async stop(userId: string, dto: StopTimerSessionDto = {}) {
    const session = await this.requireRow(userId);
    await this.assertAttributionOwned(userId, dto);

    const now = new Date();
    const rawElapsedMs = computeElapsedMs(session, now);
    const capped = rawElapsedMs > MAX_SESSION_MS;
    const elapsedMs = capped ? MAX_SESSION_MS : rawElapsedMs;
    const duration = toDurationMinutes(elapsedMs);

    const goalId = dto.goalId !== undefined ? dto.goalId : session.goalId;
    const taskId = dto.taskId !== undefined ? dto.taskId : session.taskId;
    const scheduleBlockId =
      dto.scheduleBlockId !== undefined
        ? dto.scheduleBlockId
        : session.scheduleBlockId;
    const notes = dto.notes !== undefined ? dto.notes : session.notes;

    let taskTitle: string | null = null;
    if (taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: taskId, userId },
        select: { title: true },
      });
      taskTitle = task?.title ?? null;
    }

    const explicitName =
      dto.taskName !== undefined ? dto.taskName : session.taskName;
    const taskName = explicitName?.trim() || taskTitle || DEFAULT_TASK_NAME;

    // `date` is the LOCAL CALENDAR DATE the session STARTED on, not the
    // moment it stopped and not the raw startedAt instant — so a session
    // that runs across midnight lands on the day the work began, and the
    // stored value matches the UTC-midnight-of-a-calendar-date shape every
    // other write path produces (see toLocalDateOnly above). Storing the raw
    // instant here previously corrupted day bucketing: reports read `date`
    // via `.toISOString().split('T')[0]`, which is not the same calendar day
    // as `session.startedAt` whenever the session started outside the UTC
    // 00:00-23:59 window relative to the server's local day.
    const date = toLocalDateOnly(session.startedAt);

    const entry = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.activeTimerSession.deleteMany({
        where: { id: session.id, userId },
      });
      if (count === 0) {
        throw new ConflictException({
          code: ACTIVE_SESSION_ALREADY_STOPPED,
          message: 'This timer session was already stopped by another device.',
        });
      }

      return tx.timeEntry.create({
        data: {
          taskName,
          taskTitle: taskTitle ?? undefined,
          duration,
          date,
          dayOfWeek: date.getUTCDay(),
          startedAt: session.startedAt,
          notes: notes ?? undefined,
          userId,
          goalId: goalId ?? undefined,
          taskId: taskId ?? undefined,
          scheduleBlockId: scheduleBlockId ?? undefined,
          source: 'TRACKER',
        },
        // Trimmed to match ATTRIBUTION_INCLUDE's goal shape (and
        // TimeEntriesService's own create/update) rather than pulling the
        // entire Goal row — every reader of this response only ever uses
        // id/title/color/category, and the full row leaks fields like
        // loggedHours/targetHours/deadline that have no reason to ride along
        // on a stop() response.
        include: {
          goal: {
            select: { id: true, title: true, color: true, category: true },
          },
        },
      });
    });

    // Outside the transaction on purpose: updateProgress recomputes
    // loggedHours from a SUM over TimeEntry, so it is idempotent and safe to
    // run after commit. Keeping it out avoids holding the row lock on Goal
    // for the length of an aggregate.
    if (goalId) {
      await this.goalsService.updateProgress(goalId, userId);
    }

    return {
      timeEntry: entry,
      elapsedMs: rawElapsedMs,
      durationMinutes: duration,
      capped,
      maxSessionMs: MAX_SESSION_MS,
    };
  }

  /**
   * Abandon the session without writing a TimeEntry. This is the escape hatch
   * for an accidental start — without it, the 1-minute floor in
   * `toDurationMinutes` would mean a three-second mis-tap permanently costs
   * the user a junk entry to go and delete.
   */
  async discard(userId: string) {
    const { count } = await this.prisma.activeTimerSession.deleteMany({
      where: { userId },
    });
    return { discarded: count > 0 };
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private async findRow(userId: string): Promise<SessionRow | null> {
    const session = await this.prisma.activeTimerSession.findUnique({
      where: { userId },
      include: ATTRIBUTION_INCLUDE,
    });
    return (session as SessionRow) ?? null;
  }

  private async requireRow(userId: string): Promise<SessionRow> {
    const session = await this.findRow(userId);
    if (!session) throw new NotFoundException('No active timer session');
    return session;
  }

  /**
   * Attribution ids must belong to the caller. Without this a client could
   * pin its time to another user's goal, which the foreign key alone would
   * happily accept.
   */
  private async assertAttributionOwned(
    userId: string,
    dto: {
      goalId?: string | null;
      taskId?: string | null;
      scheduleBlockId?: string | null;
    },
  ) {
    const checks: Promise<void>[] = [];

    if (dto.goalId) {
      checks.push(
        this.prisma.goal
          .count({ where: { id: dto.goalId, userId } })
          .then((n) => {
            if (n === 0) throw new BadRequestException('Goal not found');
          }),
      );
    }
    if (dto.taskId) {
      checks.push(
        this.prisma.task
          .count({ where: { id: dto.taskId, userId } })
          .then((n) => {
            if (n === 0) throw new BadRequestException('Task not found');
          }),
      );
    }
    if (dto.scheduleBlockId) {
      checks.push(
        this.prisma.scheduleBlock
          .count({ where: { id: dto.scheduleBlockId, userId } })
          .then((n) => {
            if (n === 0)
              throw new BadRequestException('Schedule block not found');
          }),
      );
    }

    if (checks.length) await Promise.all(checks);
  }

  private async assertDailyEntryHeadroom(userId: string, now: Date) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(23, 59, 59, 999);

    const todayEntries = await this.prisma.timeEntry.count({
      where: { userId, date: { gte: dayStart, lte: dayEnd } },
    });

    await this.authService.checkPlanLimit(userId, 'tasksPerDay', todayEntries);
  }

  private toResponse(session: SessionRow, now: Date = new Date()) {
    const elapsedMs = computeElapsedMs(session, now);

    return {
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      segmentStartedAt: session.segmentStartedAt,
      pausedAt: session.pausedAt,
      accumulatedMs: session.accumulatedMs,

      /**
       * Server-computed so every device agrees, and paired with `serverTime`
       * so a client whose own clock is skewed can keep ticking locally
       * without drifting away from what the next GET will say.
       */
      elapsedMs,
      serverTime: now,

      /**
       * Stale sessions are reported, never auto-resolved.
       *
       * Auto-stopping would silently write a time entry the user never asked
       * for, at a duration the server invented — the exact "72-hour entry
       * appears out of nowhere" outcome we are trying to avoid. Deleting it
       * would throw away a session that may be perfectly legitimate (a
       * long-running paused session left over the weekend). So the row is
       * left alone and the truth is surfaced: the client shows "this has been
       * running since Friday — save 12h or discard?" and the user decides.
       *
       * `cappedElapsedMs` is what a stop would actually write.
       */
      isStale: elapsedMs > STALE_AFTER_MS,
      cappedElapsedMs: Math.min(elapsedMs, MAX_SESSION_MS),
      maxSessionMs: MAX_SESSION_MS,

      taskName: session.taskName,
      notes: session.notes,
      goalId: session.goalId,
      goal: session.goal ?? null,
      taskId: session.taskId,
      task: session.task ?? null,
      scheduleBlockId: session.scheduleBlockId,
      scheduleBlock: session.scheduleBlock ?? null,
      lastClient: session.lastClient,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}

/**
 * Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError` so
 * the check keeps working when the service is exercised against a fake client
 * in unit tests.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
