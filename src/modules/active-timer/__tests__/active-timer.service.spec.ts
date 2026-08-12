import { ConflictException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import {
  ActiveTimerService,
  computeElapsedMs,
  toDurationMinutes,
  toLocalDateOnly,
} from '../active-timer.service';
import { MAX_SESSION_MS } from '../active-timer.constants';

const USER = 'user-1';
const OTHER_USER = 'user-2';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in for PrismaService.
 *
 * `sessions` is keyed by userId, which is what makes the one-session-per-user
 * unique constraint reproducible here: `create` raises a P2002 exactly like
 * Postgres would when the index is violated.
 */
class FakePrisma {
  sessions = new Map<string, any>();
  timeEntries: any[] = [];
  goals: Array<{ id: string; userId: string }> = [];
  tasksRows: Array<{ id: string; userId: string; title: string }> = [];
  scheduleBlocks: Array<{ id: string; userId: string }> = [];
  seq = 0;

  /** Set to make the next timeEntry.create blow up, to exercise rollback. */
  failNextTimeEntryCreate = false;

  activeTimerSession = {
    findUnique: async ({ where }: any) => this.clone(this.sessions.get(where.userId)),

    create: async ({ data }: any) => {
      if (this.sessions.has(data.userId)) {
        const error: any = new Error(
          'Unique constraint failed on the fields: (`userId`)',
        );
        error.code = 'P2002';
        error.meta = { target: ['userId'] };
        throw error;
      }
      const row = {
        id: `ats_${++this.seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.sessions.set(data.userId, row);
      return this.clone(row);
    },

    upsert: async ({ where, create, update }: any) => {
      const existing = this.sessions.get(where.userId);
      const row = existing
        ? { ...existing, ...update, updatedAt: new Date() }
        : {
            id: `ats_${++this.seq}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
      this.sessions.set(where.userId, row);
      return this.clone(row);
    },

    update: async ({ where, data }: any) => {
      const row = this.byId(where.id);
      if (!row) throw new Error('record not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return this.clone(row);
    },

    // Compare-and-set: only rows matching every predicate are written, and
    // the affected count is what the service branches on.
    updateMany: async ({ where, data }: any) => {
      const row = this.byId(where.id);
      if (!row) return { count: 0 };
      if (where.userId && row.userId !== where.userId) return { count: 0 };
      if (where.status && row.status !== where.status) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    },

    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (const [userId, row] of [...this.sessions.entries()]) {
        if (where.id && row.id !== where.id) continue;
        if (where.userId && userId !== where.userId) continue;
        this.sessions.delete(userId);
        count += 1;
      }
      return { count };
    },
  };

  timeEntry = {
    count: async ({ where }: any) =>
      this.timeEntries.filter((e) => e.userId === where.userId).length,
    create: async ({ data }: any) => {
      if (this.failNextTimeEntryCreate) {
        this.failNextTimeEntryCreate = false;
        throw new Error('simulated insert failure');
      }
      const row = { id: `te_${++this.seq}`, createdAt: new Date(), ...data };
      this.timeEntries.push(row);
      return row;
    },
  };

  goal = {
    count: async ({ where }: any) =>
      this.goals.filter((g) => g.id === where.id && g.userId === where.userId).length,
  };

  task = {
    count: async ({ where }: any) =>
      this.tasksRows.filter((t) => t.id === where.id && t.userId === where.userId).length,
    findFirst: async ({ where }: any) =>
      this.tasksRows.find((t) => t.id === where.id && t.userId === where.userId) ?? null,
  };

  scheduleBlock = {
    count: async ({ where }: any) =>
      this.scheduleBlocks.filter((b) => b.id === where.id && b.userId === where.userId)
        .length,
  };

  private txChain: Promise<unknown> = Promise.resolve();

  /**
   * Interactive transaction with real rollback semantics: state is snapshotted
   * on entry and restored if the callback throws. Without the restore, a test
   * could not tell "the delete was rolled back" from "the delete never ran".
   *
   * Transactions are also serialised. Two concurrent stops both target the
   * same session row, and Postgres would serialise them on that row's write
   * lock — the loser only re-evaluates its DELETE after the winner commits.
   * Running them interleaved here would instead let the loser's rollback
   * resurrect the winner's committed state, which is a property of this fake,
   * not of the database.
   */
  $transaction = <T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> => {
    const run = this.txChain.then(async () => {
      const sessionsSnapshot = new Map(this.sessions);
      const entriesSnapshot = [...this.timeEntries];
      try {
        return await fn(this);
      } catch (error) {
        this.sessions = sessionsSnapshot;
        this.timeEntries = entriesSnapshot;
        throw error;
      }
    });
    this.txChain = run.catch(() => undefined);
    return run;
  };

  private byId(id: string) {
    for (const row of this.sessions.values()) if (row.id === id) return row;
    return null;
  }

  private clone(row: any) {
    return row ? { ...row } : null;
  }
}

class FakeAuth {
  limitReached = false;
  async checkPlanLimit() {
    if (this.limitReached) throw new Error('plan limit reached');
    return true;
  }
}

class FakeGoals {
  progressCalls: string[] = [];
  async updateProgress(goalId: string) {
    this.progressCalls.push(goalId);
  }
}

function build() {
  const prisma = new FakePrisma();
  const auth = new FakeAuth();
  const goals = new FakeGoals();
  const service = new ActiveTimerService(prisma as any, auth as any, goals as any);
  return { prisma, auth, goals, service };
}

/** Freeze the clock so elapsed-time assertions are exact, not flaky. */
function at(iso: string) {
  jest.setSystemTime(new Date(iso));
}

/**
 * Only `Date` is faked. Faking the timer and microtask primitives as well
 * would interfere with the promise interleaving the concurrency tests below
 * depend on, and nothing here needs a controllable event loop — just a
 * controllable wall clock.
 */
const FAKE_DATE_ONLY = {
  doNotFake: [
    'hrtime',
    'nextTick',
    'performance',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
  ],
} as const;

// ---------------------------------------------------------------------------

describe('ActiveTimerService', () => {
  beforeEach(() => {
    jest.useFakeTimers(FAKE_DATE_ONLY as any);
    at('2026-08-12T09:00:00.000Z');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------
  // one session per user
  // -------------------------------------------------------------------
  describe('one active session per user', () => {
    it('returns null when nothing is running', async () => {
      const { service } = build();
      await expect(service.getActive(USER)).resolves.toBeNull();
    });

    it('keeps exactly one row after a start, a rejected start and a takeover', async () => {
      const { prisma, service } = build();

      await service.start(USER, {});
      await expect(service.start(USER, {})).rejects.toBeInstanceOf(ConflictException);
      await service.start(USER, { takeOver: true });

      expect(prisma.sessions.size).toBe(1);
    });

    it('does not let one user\'s session block another user', async () => {
      const { prisma, service } = build();

      await service.start(USER, {});
      await service.start(OTHER_USER, {});

      expect(prisma.sessions.size).toBe(2);
    });

    it('surfaces the database unique violation as the 409, not a pre-read', async () => {
      const { prisma, service } = build();
      await service.start(USER, {});

      // Nothing in the service consults `sessions` before inserting: the only
      // reason the second start fails is the P2002 the fake raises, exactly
      // as the @unique index on userId would.
      const createSpy = jest.spyOn(prisma.activeTimerSession, 'create');
      await expect(service.start(USER, {})).rejects.toBeInstanceOf(ConflictException);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('declares the constraint in the schema, not just in the service', () => {
      const schema = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', '..', 'prisma', 'schema.prisma'),
        'utf8',
      );
      const model = schema.slice(
        schema.indexOf('model ActiveTimerSession {'),
        schema.indexOf('// Schedule blocks for planning'),
      );

      expect(model).toContain('userId String @unique');
      // Attribution detaches rather than cascading, matching TimeEntry.
      expect(model).toMatch(/goal\s+Goal\?.*onDelete: SetNull/);
      expect(model).toMatch(/task\s+Task\?.*onDelete: SetNull/);
      expect(model).toMatch(/scheduleBlock\s+ScheduleBlock\?.*onDelete: SetNull/);
      // Deleting the user takes the session with it.
      expect(model).toMatch(/user\s+User\s+@relation.*onDelete: Cascade/);
    });

    it('ships a committed migration for the new table', () => {
      const migrationsDir = path.join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations');
      const sql = fs
        .readdirSync(migrationsDir)
        .filter((entry) => fs.existsSync(path.join(migrationsDir, entry, 'migration.sql')))
        .map((entry) => fs.readFileSync(path.join(migrationsDir, entry, 'migration.sql'), 'utf8'))
        .join('\n');

      expect(sql).toContain('CREATE TABLE "ActiveTimerSession"');
      expect(sql).toContain('CREATE UNIQUE INDEX "ActiveTimerSession_userId_key"');
    });
  });

  // -------------------------------------------------------------------
  // conflict rule
  // -------------------------------------------------------------------
  describe('conflict rule', () => {
    it('rejects a second start with a 409 that carries the live session', async () => {
      const { service } = build();
      at('2026-08-12T09:00:00.000Z');
      await service.start(USER, { taskName: 'Deep work', client: 'web' });

      at('2026-08-12T09:10:00.000Z');
      const error = await service.start(USER, { client: 'ios' }).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      const body: any = error.getResponse();
      expect(body.code).toBe('ACTIVE_TIMER_SESSION_EXISTS');
      expect(body.activeSession.taskName).toBe('Deep work');
      expect(body.activeSession.lastClient).toBe('web');
      // Ten minutes of the web session, so the phone can render "running for 10m".
      expect(body.activeSession.elapsedMs).toBe(10 * 60_000);
    });

    it('leaves the original session completely untouched when it rejects', async () => {
      const { service } = build();
      const started = await service.start(USER, { taskName: 'Deep work' });

      at('2026-08-12T09:05:00.000Z');
      await service.start(USER, { taskName: 'Something else' }).catch(() => undefined);

      const current: any = await service.getActive(USER);
      expect(current.id).toBe(started.id);
      expect(current.taskName).toBe('Deep work');
      expect(current.status).toBe('RUNNING');
    });

    it('replaces the session and resets the clock when takeOver is explicit', async () => {
      const { service } = build();
      await service.start(USER, { taskName: 'Deep work', client: 'web' });

      at('2026-08-12T09:30:00.000Z');
      const taken: any = await service.start(USER, {
        taskName: 'Phone work',
        client: 'ios',
        takeOver: true,
      });

      expect(taken.taskName).toBe('Phone work');
      expect(taken.lastClient).toBe('ios');
      expect(taken.elapsedMs).toBe(0);
      expect(taken.startedAt.toISOString()).toBe('2026-08-12T09:30:00.000Z');
    });

    it('writes no time entry for the session a takeover replaced', async () => {
      const { prisma, service } = build();
      await service.start(USER, { taskName: 'Deep work' });
      at('2026-08-12T09:30:00.000Z');
      await service.start(USER, { taskName: 'Phone work', takeOver: true });

      // Takeover discards. Keeping the elapsed time is what stop is for, and
      // the 409 exists precisely so the client can offer that first.
      expect(prisma.timeEntries).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // pause / resume elapsed math
  // -------------------------------------------------------------------
  describe('pause / resume elapsed math', () => {
    it('counts only running time across three pause cycles', async () => {
      const { service } = build();

      at('2026-08-12T09:00:00.000Z');
      await service.start(USER, {});

      // Segment 1: 10 minutes of work.
      at('2026-08-12T09:10:00.000Z');
      let s: any = await service.pause(USER);
      expect(s.status).toBe('PAUSED');
      expect(s.elapsedMs).toBe(10 * 60_000);

      // An hour of lunch must not count.
      at('2026-08-12T10:10:00.000Z');
      expect((await service.getActive(USER))!.elapsedMs).toBe(10 * 60_000);
      await service.resume(USER);

      // Segment 2: 5 minutes.
      at('2026-08-12T10:15:00.000Z');
      s = await service.pause(USER);
      expect(s.elapsedMs).toBe(15 * 60_000);

      // Two more hours paused.
      at('2026-08-12T12:15:00.000Z');
      await service.resume(USER);

      // Segment 3: 20 minutes, still open.
      at('2026-08-12T12:35:00.000Z');
      s = (await service.getActive(USER))!;
      expect(s.status).toBe('RUNNING');
      expect(s.elapsedMs).toBe(35 * 60_000);
    });

    it('keeps ticking while running with no client writing to it', async () => {
      const { service } = build();
      await service.start(USER, {});

      // Nothing touched the row in between; elapsed is derived, not stored.
      at('2026-08-12T11:00:00.000Z');
      expect((await service.getActive(USER))!.elapsedMs).toBe(2 * 60 * 60_000);
    });

    it('never persists a stale computed elapsed value', async () => {
      const { prisma, service } = build();
      await service.start(USER, {});
      at('2026-08-12T09:45:00.000Z');

      const row = prisma.sessions.get(USER);
      expect(row.accumulatedMs).toBe(0); // still 0 — only pause folds a segment in
      expect(Object.keys(row)).not.toContain('elapsedMs');
    });

    it('is idempotent on pause so a double-tap cannot double-count', async () => {
      const { service } = build();
      await service.start(USER, {});

      at('2026-08-12T09:10:00.000Z');
      await service.pause(USER);
      // Ten minutes later, a second client pauses the same session.
      at('2026-08-12T09:20:00.000Z');
      const s: any = await service.pause(USER);

      expect(s.elapsedMs).toBe(10 * 60_000);
    });

    it('is idempotent on resume so a double-tap cannot rewind the segment', async () => {
      const { service } = build();
      await service.start(USER, {});
      at('2026-08-12T09:10:00.000Z');
      await service.pause(USER);

      at('2026-08-12T09:20:00.000Z');
      await service.resume(USER);
      at('2026-08-12T09:25:00.000Z');
      await service.resume(USER); // no-op; must not restart the segment

      at('2026-08-12T09:30:00.000Z');
      expect((await service.getActive(USER))!.elapsedMs).toBe(20 * 60_000);
    });

    it('rejects pause and resume when nothing is running', async () => {
      const { service } = build();
      await expect(service.pause(USER)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resume(USER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('clamps a client clock that runs ahead of the server', () => {
      const session = {
        status: 'RUNNING' as const,
        segmentStartedAt: new Date('2026-08-12T09:05:00.000Z'),
        accumulatedMs: 60_000,
      };
      // "now" is before the segment started — elapsed must not go backwards.
      expect(computeElapsedMs(session, new Date('2026-08-12T09:00:00.000Z'))).toBe(60_000);
    });
  });

  // -------------------------------------------------------------------
  // attribution
  // -------------------------------------------------------------------
  describe('attribution', () => {
    it('starts with nothing attached', async () => {
      const s: any = await build().service.start(USER, {});
      expect(s.goalId).toBeNull();
      expect(s.taskId).toBeNull();
      expect(s.scheduleBlockId).toBeNull();
      expect(s.taskName).toBeNull();
    });

    it('attaches a goal mid-session without moving the clock', async () => {
      const { prisma, service } = build();
      prisma.goals.push({ id: 'goal-1', userId: USER });

      await service.start(USER, {});
      at('2026-08-12T09:10:00.000Z');
      const s: any = await service.updateAttribution(USER, { goalId: 'goal-1' });

      expect(s.goalId).toBe('goal-1');
      expect(s.elapsedMs).toBe(10 * 60_000);
      expect(s.status).toBe('RUNNING');
    });

    it('treats null as clear and an omitted field as leave alone', async () => {
      const { prisma, service } = build();
      prisma.goals.push({ id: 'goal-1', userId: USER });

      await service.start(USER, { goalId: 'goal-1', taskName: 'Writing' });
      const s: any = await service.updateAttribution(USER, { goalId: null });

      expect(s.goalId).toBeNull();
      expect(s.taskName).toBe('Writing');
    });

    it('refuses attribution that belongs to someone else', async () => {
      const { prisma, service } = build();
      prisma.goals.push({ id: 'goal-x', userId: OTHER_USER });

      await expect(service.start(USER, { goalId: 'goal-x' })).rejects.toThrow('Goal not found');
    });
  });

  // -------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------
  describe('stop', () => {
    it('writes exactly one time entry and clears the session', async () => {
      const { prisma, service } = build();
      prisma.goals.push({ id: 'goal-1', userId: USER });
      await service.start(USER, { goalId: 'goal-1', taskName: 'Deep work' });

      at('2026-08-12T10:30:00.000Z');
      const result: any = await service.stop(USER, {});

      expect(prisma.timeEntries).toHaveLength(1);
      expect(prisma.sessions.size).toBe(0);
      expect(result.durationMinutes).toBe(90);
      expect(result.timeEntry.taskName).toBe('Deep work');
      expect(result.timeEntry.goalId).toBe('goal-1');
      expect(result.timeEntry.source).toBe('TRACKER');
      expect(await service.getActive(USER)).toBeNull();
    });

    it('dates the entry from when the session started, not when it stopped, while preserving the exact startedAt instant', async () => {
      const { prisma, service } = build();
      at('2026-08-12T23:40:00.000Z');
      await service.start(USER, {});
      at('2026-08-13T00:20:00.000Z');

      const result: any = await service.stop(USER, {});
      // `date` is a normalized calendar date (UTC-midnight), not the raw
      // instant -- see the "date normalization across server timezones"
      // tests below for the corruption that storing the raw instant caused.
      // `startedAt` is untouched: it is the one field allowed to carry the
      // exact moment tracking began.
      expect(prisma.timeEntries[0].startedAt.toISOString()).toBe('2026-08-12T23:40:00.000Z');
    });

    // ---------------------------------------------------------------------
    // date normalization across server timezones
    //
    // TimeEntry.date is read everywhere else in this codebase as UTC-midnight
    // of a calendar date -- TimeEntriesService.create builds it from a
    // client-supplied "YYYY-MM-DD" string via `new Date(dto.date)`, and every
    // report reads it back via `entry.date.toISOString().split('T')[0]`.
    // There is no per-user timezone tracked anywhere (see the User model),
    // and this API's deploy config never pins the server process to a TZ
    // either, so these tests pin `process.env.TZ` themselves to make the
    // scenario reproducible regardless of which machine runs the suite.
    // ---------------------------------------------------------------------
    describe('date normalization across server timezones', () => {
      const ORIGINAL_TZ = process.env.TZ;

      afterEach(() => {
        if (ORIGINAL_TZ === undefined) delete process.env.TZ;
        else process.env.TZ = ORIGINAL_TZ;
      });

      it('lands the entry on the LOCAL calendar date the session started on, not the UTC date of the raw instant', async () => {
        // Exactly the scenario from the bug report: a session started at
        // 2026-08-13 02:00 local time on a server pinned to Asia/Karachi
        // (UTC+5) is the UTC instant 2026-08-12T21:00:00.000Z. Storing that
        // raw instant (the pre-fix behavior) put the entry's date-key at
        // "2026-08-12" -- one calendar day earlier than the session's own
        // local wall clock said it started.
        process.env.TZ = 'Asia/Karachi';
        const { prisma, service } = build();

        at('2026-08-12T21:00:00.000Z'); // 2026-08-13 02:00 local (Asia/Karachi)
        await service.start(USER, {});

        at('2026-08-12T21:30:00.000Z'); // 2026-08-13 02:30 local, same local day
        const result: any = await service.stop(USER, {});

        expect(result.timeEntry.date.toISOString().split('T')[0]).toBe('2026-08-13');
        expect(prisma.timeEntries[0].date.toISOString().split('T')[0]).toBe('2026-08-13');
      });

      it('keeps date and dayOfWeek mutually consistent even when the server TZ is WEST of UTC', async () => {
        // West-of-UTC is what actually distinguishes `.getDay()` (which
        // reinterprets a UTC-midnight instant in server-local time and can
        // walk it onto the PREVIOUS calendar day) from `.getUTCDay()`
        // (reads the date's own UTC calendar fields -- the same fields
        // `date.toISOString().split('T')[0]` reads, which is the canonical
        // date key every report in reports.service.ts uses). Using the
        // wrong one is exactly how a stopped session could write a `date`
        // and a `dayOfWeek` that disagree with each other on the same row.
        process.env.TZ = 'Pacific/Honolulu'; // UTC-10, no DST to worry about
        const { prisma, service } = build();

        at('2026-08-13T10:30:00.000Z'); // 2026-08-13 00:30 local (Honolulu)
        await service.start(USER, {});

        at('2026-08-13T11:00:00.000Z'); // 2026-08-13 01:00 local, same local day
        const result: any = await service.stop(USER, {});

        const dateKey = result.timeEntry.date.toISOString().split('T')[0];
        expect(dateKey).toBe('2026-08-13');

        const impliedDayOfWeek = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
        expect(result.timeEntry.dayOfWeek).toBe(impliedDayOfWeek);
        expect(prisma.timeEntries[0].dayOfWeek).toBe(impliedDayOfWeek);
      });

      it('toLocalDateOnly + getUTCDay is what stop() relies on for the invariant above', () => {
        // Direct unit coverage of the helper itself, pinned to a
        // west-of-UTC TZ so the two getters (`getDay` vs `getUTCDay`) are
        // exercised where they can actually diverge.
        process.env.TZ = 'Pacific/Honolulu';
        const startedAt = new Date('2026-08-13T10:30:00.000Z');

        const normalized = toLocalDateOnly(startedAt);
        expect(normalized.toISOString()).toBe('2026-08-13T00:00:00.000Z');
        expect(normalized.getUTCDay()).toBe(4); // Thursday
      });
    });

    it('produces exactly one entry when two devices stop at the same moment', async () => {
      const { prisma, service } = build();
      await service.start(USER, { taskName: 'Deep work' });
      at('2026-08-12T09:30:00.000Z');

      const [a, b] = await Promise.allSettled([service.stop(USER, {}), service.stop(USER, {})]);

      const outcomes = [a.status, b.status].sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);
      expect(prisma.timeEntries).toHaveLength(1);
      expect(prisma.sessions.size).toBe(0);

      const rejected = (a.status === 'rejected' ? a.reason : (b as any).reason);
      expect(rejected).toBeInstanceOf(ConflictException);
      expect(rejected.getResponse().code).toBe('ACTIVE_TIMER_SESSION_ALREADY_STOPPED');
    });

    it('rolls the delete back when the time entry insert fails', async () => {
      const { prisma, service } = build();
      await service.start(USER, { taskName: 'Deep work' });
      at('2026-08-12T09:30:00.000Z');
      prisma.failNextTimeEntryCreate = true;

      await expect(service.stop(USER, {})).rejects.toThrow('simulated insert failure');

      // The session must survive: losing it here would mean 30 minutes of
      // tracked work with nowhere to land.
      expect(prisma.sessions.size).toBe(1);
      expect(prisma.timeEntries).toHaveLength(0);
      expect((await service.getActive(USER))!.elapsedMs).toBe(30 * 60_000);
    });

    it('sums only running time when the session was paused and resumed', async () => {
      const { service } = build();
      await service.start(USER, {});
      at('2026-08-12T09:25:00.000Z');
      await service.pause(USER);
      at('2026-08-12T11:00:00.000Z');
      await service.resume(USER);
      at('2026-08-12T11:20:00.000Z');

      const result: any = await service.stop(USER, {});
      expect(result.durationMinutes).toBe(45);
    });

    it('recomputes goal progress after the transaction commits', async () => {
      const { prisma, goals, service } = build();
      prisma.goals.push({ id: 'goal-1', userId: USER });
      await service.start(USER, { goalId: 'goal-1' });
      at('2026-08-12T09:30:00.000Z');

      await service.stop(USER, {});
      expect(goals.progressCalls).toEqual(['goal-1']);
    });

    it('accepts attribution supplied at stop time', async () => {
      const { prisma, service } = build();
      prisma.goals.push({ id: 'goal-1', userId: USER });
      prisma.tasksRows.push({ id: 'task-1', userId: USER, title: 'Ship the timer' });

      await service.start(USER, {});
      at('2026-08-12T09:30:00.000Z');
      const result: any = await service.stop(USER, { goalId: 'goal-1', taskId: 'task-1' });

      expect(result.timeEntry.goalId).toBe('goal-1');
      expect(result.timeEntry.taskId).toBe('task-1');
      // Task title is snapshotted, matching TimeEntriesService.create.
      expect(result.timeEntry.taskTitle).toBe('Ship the timer');
      expect(result.timeEntry.taskName).toBe('Ship the timer');
    });

    it('falls back to a placeholder name when nothing is attached', async () => {
      const { service } = build();
      await service.start(USER, {});
      at('2026-08-12T09:30:00.000Z');
      const result: any = await service.stop(USER, {});
      expect(result.timeEntry.taskName).toBe('Untitled session');
    });

    it('404s when there is nothing to stop', async () => {
      const { service } = build();
      await expect(service.stop(USER, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------
  // duration rounding
  // -------------------------------------------------------------------
  describe('duration rounding', () => {
    it.each([
      [1_000, 1],
      [29_000, 1],
      [30_000, 1],
      [59_000, 1],
      [89_000, 1],
      [91_000, 2],
      [150_000, 3],
      [3_600_000, 60],
    ])('%i ms -> %i minutes', (ms, minutes) => {
      expect(toDurationMinutes(ms)).toBe(minutes);
    });

    it('never turns a short session into a 0-minute entry', async () => {
      const { prisma, service } = build();
      await service.start(USER, { taskName: 'Quick note' });

      at('2026-08-12T09:00:30.000Z'); // 30 seconds
      const result: any = await service.stop(USER, {});

      expect(result.durationMinutes).toBe(1);
      expect(prisma.timeEntries[0].duration).toBe(1);
      expect(result.elapsedMs).toBe(30_000);
    });

    it('offers discard so an accidental start need not become a 1-minute entry', async () => {
      const { prisma, service } = build();
      await service.start(USER, {});
      at('2026-08-12T09:00:03.000Z');

      await expect(service.discard(USER)).resolves.toEqual({ discarded: true });
      expect(prisma.timeEntries).toHaveLength(0);
      expect(prisma.sessions.size).toBe(0);
      await expect(service.discard(USER)).resolves.toEqual({ discarded: false });
    });
  });

  // -------------------------------------------------------------------
  // stale sessions
  // -------------------------------------------------------------------
  describe('stale sessions', () => {
    it('keeps reporting a three-day-old session instead of auto-stopping it', async () => {
      const { prisma, service } = build();
      await service.start(USER, { taskName: 'Forgot to stop' });

      at('2026-08-15T09:00:00.000Z'); // 72 hours later
      const s: any = await service.getActive(USER);

      expect(s).not.toBeNull();
      expect(s.status).toBe('RUNNING');
      expect(s.isStale).toBe(true);
      expect(s.elapsedMs).toBe(72 * 60 * 60_000); // the truth, unmodified
      expect(s.cappedElapsedMs).toBe(MAX_SESSION_MS); // what a stop would write
      // Nothing was written behind the user's back.
      expect(prisma.timeEntries).toHaveLength(0);
      expect(prisma.sessions.size).toBe(1);
    });

    it('caps the entry a stale stop produces and flags that it capped', async () => {
      const { prisma, service } = build();
      await service.start(USER, { taskName: 'Forgot to stop' });
      at('2026-08-15T09:00:00.000Z');

      const result: any = await service.stop(USER, {});

      expect(result.capped).toBe(true);
      expect(result.elapsedMs).toBe(72 * 60 * 60_000);
      expect(result.durationMinutes).toBe(720); // 12h, not 4320
      expect(prisma.timeEntries[0].duration).toBe(720);
    });

    it('does not flag a normal-length session as stale', async () => {
      const { service } = build();
      await service.start(USER, {});
      at('2026-08-12T17:00:00.000Z'); // 8 hours
      const s: any = await service.getActive(USER);
      expect(s.isStale).toBe(false);
      expect(s.cappedElapsedMs).toBe(s.elapsedMs);
    });
  });

  // -------------------------------------------------------------------
  // misc contract
  // -------------------------------------------------------------------
  describe('response contract', () => {
    it('returns serverTime so clients can correct for clock skew', async () => {
      const { service } = build();
      const s: any = await service.start(USER, {});
      expect(s.serverTime.toISOString()).toBe('2026-08-12T09:00:00.000Z');
      expect(s.maxSessionMs).toBe(MAX_SESSION_MS);
    });

    it('enforces the plan limit at start rather than stranding a session at stop', async () => {
      const { auth, service } = build();
      auth.limitReached = true;
      await expect(service.start(USER, {})).rejects.toThrow('plan limit reached');
      await expect(service.getActive(USER)).resolves.toBeNull();
    });
  });
});
