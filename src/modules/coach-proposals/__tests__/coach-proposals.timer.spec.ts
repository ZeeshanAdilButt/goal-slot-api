import { CoachProposalsService } from '../coach-proposals.service';
import { COACH_ACTION_TYPES } from '../dto/apply-proposals.dto';
import { ActiveTimerService } from '../../active-timer/active-timer.service';

const USER = 'user-1';

// ---------------------------------------------------------------------------
// Fakes
//
// The real ActiveTimerService is wired in rather than stubbed. The whole point
// of these two actions is that they drive the same session lifecycle the
// clients' own timer buttons drive, so a stub that always resolves would prove
// nothing: the 409 body shape, the elapsed-time maths and the stop-writes-a-
// TimeEntry transaction are exactly what has to keep working. Only Prisma,
// plan limits and goal-progress are faked.
// ---------------------------------------------------------------------------

class FakePrisma {
  sessions = new Map<string, any>();
  timeEntries: any[] = [];
  goals: Array<{ id: string; userId: string; title: string; status: string }> = [];
  tasksRows: Array<{ id: string; userId: string; title: string }> = [];
  blocks: Array<{ id: string; userId: string }> = [];
  seq = 0;

  /** Resolve the `include: { goal, task, scheduleBlock }` the service asks for. */
  private hydrate(row: any) {
    if (!row) return null;
    const goal = this.goals.find((g) => g.id === row.goalId);
    const task = this.tasksRows.find((t) => t.id === row.taskId);
    const block = this.blocks.find((b) => b.id === row.scheduleBlockId);
    return {
      ...row,
      goal: goal ? { id: goal.id, title: goal.title, color: '#FFD700' } : null,
      task: task ? { id: task.id, title: task.title } : null,
      scheduleBlock: block ? { id: block.id, title: 'block' } : null,
    };
  }

  activeTimerSession = {
    findUnique: async ({ where }: any) => this.hydrate(this.sessions.get(where.userId)),

    // Keyed by userId, so the one-session-per-user unique index is reproduced
    // here: a second insert raises P2002 exactly like Postgres would.
    create: async ({ data }: any) => {
      if (this.sessions.has(data.userId)) {
        const error: any = new Error(
          'Unique constraint failed on the fields: (`userId`)',
        );
        error.code = 'P2002';
        throw error;
      }
      const row = {
        id: `ats_${++this.seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.sessions.set(data.userId, row);
      return this.hydrate(row);
    },

    upsert: async ({ where, create, update }: any) => {
      const existing = this.sessions.get(where.userId);
      const row = existing
        ? { ...existing, ...update, updatedAt: new Date() }
        : { id: `ats_${++this.seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
      this.sessions.set(where.userId, row);
      return this.hydrate(row);
    },

    update: async ({ where, data }: any) => {
      const row = this.byId(where.id);
      if (!row) throw new Error('record not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return this.hydrate(row);
    },

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
      const row = { id: `te_${++this.seq}`, createdAt: new Date(), ...data };
      this.timeEntries.push(row);
      return row;
    },
  };

  goal = {
    count: async ({ where }: any) =>
      this.goals.filter((g) => g.id === where.id && g.userId === where.userId).length,
    findMany: async ({ where }: any) => this.goals.filter((g) => g.userId === where.userId),
  };

  task = {
    count: async ({ where }: any) =>
      this.tasksRows.filter((t) => t.id === where.id && t.userId === where.userId).length,
    findFirst: async ({ where }: any) =>
      this.tasksRows.find((t) => t.id === where.id && t.userId === where.userId) ?? null,
  };

  scheduleBlock = {
    count: async ({ where }: any) =>
      this.blocks.filter((b) => b.id === where.id && b.userId === where.userId).length,
    findFirst: async () => null,
  };

  $transaction = async <T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> => {
    const sessionsSnapshot = new Map(this.sessions);
    const entriesSnapshot = [...this.timeEntries];
    try {
      return await fn(this);
    } catch (error) {
      this.sessions = sessionsSnapshot;
      this.timeEntries = entriesSnapshot;
      throw error;
    }
  };

  private byId(id: string) {
    for (const row of this.sessions.values()) if (row.id === id) return row;
    return null;
  }
}

class FakeAuth {
  async checkPlanLimit() {
    return true;
  }
}

class FakeGoalsService {
  progressCalls: string[] = [];
  async updateProgress(goalId: string) {
    this.progressCalls.push(goalId);
  }
}

/**
 * The domain services the other twelve action types dispatch onto. Anything
 * these get called with would mean a timer action leaked into the wrong branch
 * of the switch, so they throw rather than resolve.
 */
function unusedService(name: string) {
  return new Proxy(
    {},
    {
      get: (_t, prop) => () => {
        throw new Error(`${name}.${String(prop)} should not be called by a timer action`);
      },
    },
  );
}

function build() {
  const prisma = new FakePrisma();
  const goalsService = new FakeGoalsService();
  const activeTimer = new ActiveTimerService(
    prisma as any,
    new FakeAuth() as any,
    goalsService as any,
  );
  const service = new CoachProposalsService(
    prisma as any,
    unusedService('goals') as any,
    unusedService('schedule') as any,
    unusedService('timeEntries') as any,
    unusedService('tasks') as any,
    unusedService('insights') as any,
    activeTimer,
  );
  return { prisma, service, activeTimer, goalsService };
}

function addGoal(
  prisma: FakePrisma,
  id: string,
  title: string,
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED' = 'ACTIVE',
) {
  prisma.goals.push({ id, userId: USER, title, status });
  return id;
}

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

const at = (iso: string) => jest.setSystemTime(new Date(iso));

// ---------------------------------------------------------------------------

describe('CoachProposalsService — timer actions', () => {
  beforeEach(() => {
    jest.useFakeTimers(FAKE_DATE_ONLY as any);
    at('2026-08-12T09:00:00.000Z');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------
  // the types exist at all
  // -------------------------------------------------------------------
  describe('action type registration', () => {
    // Both clients validate model output against their own copy of this list
    // and DROP unknown types, so a type the API dispatches but never declares
    // would be discarded before it ever reached /apply. The list is the
    // contract, not the switch statement.
    it('declares START_TIMER and STOP_TIMER as accepted action types', () => {
      expect(COACH_ACTION_TYPES).toContain('START_TIMER');
      expect(COACH_ACTION_TYPES).toContain('STOP_TIMER');
    });

    it('rejects an unknown type rather than silently succeeding', async () => {
      const { service } = build();
      const [result] = await service.apply(USER, [{ type: 'PAUSE_TIMER' as any }]);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Unknown action type/);
    });
  });

  // -------------------------------------------------------------------
  // START_TIMER
  // -------------------------------------------------------------------
  describe('START_TIMER', () => {
    it('starts a running session attributed to an explicit goalId', async () => {
      const { prisma, service } = build();
      const goalId = addGoal(prisma, 'goal-deen', 'Deen');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId, taskName: 'Qur\'an reading' } },
      ]);

      expect(result.ok).toBe(true);
      expect(result.type).toBe('START_TIMER');

      const session = prisma.sessions.get(USER);
      expect(session).toBeDefined();
      expect(result.resultId).toBe(session.id);
      expect(session.status).toBe('RUNNING');
      expect(session.goalId).toBe(goalId);
      expect(session.taskName).toBe("Qur'an reading");
      // A live stopwatch, not a completed entry: nothing is logged until stop.
      expect(prisma.timeEntries).toHaveLength(0);
    });

    it('starts an unattributed session when no goal is referenced at all', async () => {
      const { prisma, service } = build();

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { taskName: 'Something' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBeNull();
    });

    it('drops takeOver even when the model puts it in the payload', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-a', 'Alpha');
      await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-a' } },
      ]);
      const original = prisma.sessions.get(USER);

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-a', takeOver: true } },
      ]);

      // Honouring it would have discarded `original` and its elapsed time.
      expect(result.ok).toBe(false);
      expect(prisma.sessions.get(USER).id).toBe(original.id);
      expect(prisma.sessions.get(USER).startedAt).toEqual(original.startedAt);
    });

    it('fails the action when the goal id does not belong to the caller', async () => {
      const { prisma, service } = build();
      prisma.goals.push({
        id: 'goal-theirs',
        userId: 'someone-else',
        title: 'Theirs',
        status: 'ACTIVE',
      });

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-theirs' } },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Goal not found/);
      expect(prisma.sessions.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // name resolution
  // -------------------------------------------------------------------
  describe('resolving a spoken goal name to a real id', () => {
    it('resolves an exact name, case-insensitively', async () => {
      const { prisma, service } = build();
      const goalId = addGoal(prisma, 'goal-deen', 'Deen');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'deen' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBe(goalId);
    });

    it('resolves a spoken phrase with filler words around the name', async () => {
      const { prisma, service } = build();
      const goalId = addGoal(prisma, 'goal-deen', 'Deen');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'my deen goal' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBe(goalId);
    });

    it('resolves a partial name against a longer goal title', async () => {
      const { prisma, service } = build();
      const goalId = addGoal(prisma, 'goal-q', "Daily Qur'an reading");

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: "Qur'an" } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBe(goalId);
    });

    it('prefers an exact match over a longer title that merely contains it', async () => {
      const { prisma, service } = build();
      const exact = addGoal(prisma, 'goal-deen', 'Deen');
      addGoal(prisma, 'goal-deen-long', 'Deen reading and tafsir');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'Deen' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBe(exact);
    });

    it('prefers the ACTIVE goal when a completed namesake also matches', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-old', 'Deen 2025', 'COMPLETED');
      const current = addGoal(prisma, 'goal-new', 'Deen 2026', 'ACTIVE');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'Deen' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBe(current);
    });

    it('never resolves to another user\'s goal', async () => {
      const { prisma, service } = build();
      prisma.goals.push({
        id: 'goal-theirs',
        userId: 'someone-else',
        title: 'Deen',
        status: 'ACTIVE',
      });

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'Deen' } },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/No goal matching "Deen"/);
      expect(prisma.sessions.size).toBe(0);
    });

    it('fails, rather than tracking to nothing, when a named goal does not exist', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-ship', 'Ship v2');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'deen' } },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/No goal matching "deen"/);
      // The point of failing: no orphan session left running against nothing.
      expect(prisma.sessions.size).toBe(0);
    });

    it('asks instead of guessing when two goals match the name equally', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-1', 'Deen reading');
      addGoal(prisma, 'goal-2', 'Deen memorisation');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'Deen' } },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/More than one goal matches "Deen"/);
      expect(result.error).toContain('"Deen reading"');
      expect(result.error).toContain('"Deen memorisation"');
      expect(prisma.sessions.size).toBe(0);
    });

    it('treats taskName as a best-effort hint: an unambiguous hit attaches the goal', async () => {
      const { prisma, service } = build();
      const goalId = addGoal(prisma, 'goal-amp', 'Ampwise');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { taskName: 'Ampwise' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBe(goalId);
      expect(prisma.sessions.get(USER).taskName).toBe('Ampwise');
    });

    it('treats taskName as a best-effort hint: a miss still starts the timer', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-ship', 'Ship v2');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { taskName: 'reading the news' } },
      ]);

      // A label was never a promise about attribution, so it must not fail.
      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBeNull();
    });

    it('lets an explicit goalId win over a conflicting goalName', async () => {
      const { prisma, service } = build();
      const explicit = addGoal(prisma, 'goal-ship', 'Ship v2');
      addGoal(prisma, 'goal-deen', 'Deen');

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: explicit, goalName: 'Deen' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.get(USER).goalId).toBe(explicit);
    });
  });

  // -------------------------------------------------------------------
  // conflict
  // -------------------------------------------------------------------
  describe('a timer is already running', () => {
    it('refuses the second start and leaves the first session untouched', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-deen', 'Deen');
      addGoal(prisma, 'goal-amp', 'Ampwise');

      await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-deen' } },
      ]);
      const original = { ...prisma.sessions.get(USER) };

      at('2026-08-12T09:12:00.000Z');
      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-amp' } },
      ]);

      expect(result.ok).toBe(false);
      expect(prisma.sessions.size).toBe(1);
      const after = prisma.sessions.get(USER);
      expect(after.id).toBe(original.id);
      expect(after.goalId).toBe('goal-deen');
      expect(after.segmentStartedAt).toEqual(original.segmentStartedAt);
      // Nothing was written for the session that was rejected, or the one running.
      expect(prisma.timeEntries).toHaveLength(0);
    });

    it('names what is already being tracked, and for how long', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-deen', 'Deen');

      await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-deen' } },
      ]);

      at('2026-08-12T09:12:00.000Z');
      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { taskName: 'Something else' } },
      ]);

      expect(result.error).toContain('"Deen"');
      expect(result.error).toContain('12 minutes');
    });

    it('reads as an explanation to the user, not an instruction to a developer', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-deen', 'Deen');
      await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-deen' } },
      ]);

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-deen' } },
      ]);

      // This string is rendered verbatim on the approval card.
      expect(result.error).not.toMatch(/takeOver/i);
      expect(result.error).not.toMatch(/409|statusCode/);
      expect(result.error).toMatch(/already tracking/i);
    });

    it('falls back to the session label when the running timer has no goal', async () => {
      const { service } = build();
      await service.apply(USER, [
        { type: 'START_TIMER', payload: { taskName: 'Deep work' } },
      ]);

      const [result] = await service.apply(USER, [
        { type: 'START_TIMER', payload: { taskName: 'Email' } },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('"Deep work"');
    });

    it('reports the conflict without failing the other actions in the batch', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-deen', 'Deen');
      await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-deen' } },
      ]);

      const results = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId: 'goal-deen' } },
        { type: 'STOP_TIMER', payload: {} },
      ]);

      expect(results[0].ok).toBe(false);
      expect(results[1].ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // STOP_TIMER
  // -------------------------------------------------------------------
  describe('STOP_TIMER', () => {
    it('converts the running session into a time entry and clears it', async () => {
      const { prisma, service, goalsService } = build();
      const goalId = addGoal(prisma, 'goal-deen', 'Deen');

      await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId, taskName: 'Tafsir' } },
      ]);

      at('2026-08-12T09:45:00.000Z');
      const [result] = await service.apply(USER, [{ type: 'STOP_TIMER', payload: {} }]);

      expect(result.ok).toBe(true);
      expect(prisma.sessions.size).toBe(0);
      expect(prisma.timeEntries).toHaveLength(1);

      const entry = prisma.timeEntries[0];
      expect(result.resultId).toBe(entry.id);
      expect(entry.duration).toBe(45);
      expect(entry.goalId).toBe(goalId);
      expect(entry.taskName).toBe('Tafsir');
      expect(entry.source).toBe('TRACKER');
      // The entry is dated from the LOCAL CALENDAR DATE the work began on,
      // not the moment it stopped and not the raw startedAt instant -- see
      // ActiveTimerService.toLocalDateOnly. Asserting only the date-key
      // (not the full instant) keeps this test agnostic to which TZ the
      // machine running the suite is in.
      expect(entry.date.toISOString().split('T')[0]).toBe('2026-08-12');
      expect(goalsService.progressCalls).toEqual([goalId]);
    });

    it('keeps the session\'s attribution when the stop payload omits it', async () => {
      const { prisma, service } = build();
      const goalId = addGoal(prisma, 'goal-deen', 'Deen');

      await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalId, taskName: 'Tafsir', notes: 'surah mulk' } },
      ]);

      at('2026-08-12T09:30:00.000Z');
      await service.apply(USER, [{ type: 'STOP_TIMER', payload: {} }]);

      const entry = prisma.timeEntries[0];
      expect(entry.goalId).toBe(goalId);
      expect(entry.taskName).toBe('Tafsir');
      expect(entry.notes).toBe('surah mulk');
    });

    it('attaches a goal named only at stop time', async () => {
      const { prisma, service } = build();
      const goalId = addGoal(prisma, 'goal-deen', 'Deen');

      // Bare start, then "that was my deen work" when stopping.
      await service.apply(USER, [{ type: 'START_TIMER', payload: {} }]);
      expect(prisma.sessions.get(USER).goalId).toBeNull();

      at('2026-08-12T10:00:00.000Z');
      const [result] = await service.apply(USER, [
        { type: 'STOP_TIMER', payload: { goalName: 'my deen goal', taskName: 'Deen' } },
      ]);

      expect(result.ok).toBe(true);
      expect(prisma.timeEntries[0].goalId).toBe(goalId);
      expect(prisma.timeEntries[0].duration).toBe(60);
    });

    it('fails, and logs nothing, when no session is running', async () => {
      const { prisma, service } = build();

      const [result] = await service.apply(USER, [{ type: 'STOP_TIMER', payload: {} }]);

      expect(result.ok).toBe(false);
      // Deliberately NOT idempotent like the DELETE_* actions: reporting ok
      // here would have the Coach tell the user their session was saved when
      // nothing was written at all.
      expect(result.error).toMatch(/nothing to stop/i);
      expect(prisma.timeEntries).toHaveLength(0);
      expect(prisma.sessions.size).toBe(0);
    });

    it('does not stop another user\'s session', async () => {
      const { prisma, service } = build();
      prisma.sessions.set('user-2', {
        id: 'ats_other',
        userId: 'user-2',
        status: 'RUNNING',
        startedAt: new Date('2026-08-12T08:00:00.000Z'),
        segmentStartedAt: new Date('2026-08-12T08:00:00.000Z'),
        pausedAt: null,
        accumulatedMs: 0,
        goalId: null,
        taskId: null,
        scheduleBlockId: null,
        taskName: null,
        notes: null,
      });

      const [result] = await service.apply(USER, [{ type: 'STOP_TIMER', payload: {} }]);

      expect(result.ok).toBe(false);
      expect(prisma.sessions.has('user-2')).toBe(true);
      expect(prisma.timeEntries).toHaveLength(0);
    });

    it('round-trips a start and a stop as one coherent session', async () => {
      const { prisma, service } = build();
      addGoal(prisma, 'goal-amp', 'Ampwise');

      const started = await service.apply(USER, [
        { type: 'START_TIMER', payload: { goalName: 'Ampwise' } },
      ]);
      expect(started[0].ok).toBe(true);

      at('2026-08-12T10:30:00.000Z');
      const stopped = await service.apply(USER, [{ type: 'STOP_TIMER', payload: {} }]);

      expect(stopped[0].ok).toBe(true);
      expect(prisma.timeEntries).toHaveLength(1);
      expect(prisma.timeEntries[0].duration).toBe(90);
      expect(prisma.timeEntries[0].goalId).toBe('goal-amp');
    });

    // -----------------------------------------------------------------
    // the 12-hour session cap
    //
    // ActiveTimerService.stop() caps what it writes at MAX_SESSION_MS and
    // reports `capped: true`, but that flag used to be discarded the moment
    // it reached the Coach: `dispatch()` for STOP_TIMER returned only
    // `(stopped as any)?.timeEntry?.id`, so a genuine 14-hour session
    // stopped via the Coach silently wrote 12 hours and reported plain
    // success. These tests are the regression coverage for surfacing that
    // through `warning` instead.
    // -----------------------------------------------------------------
    it('reports a warning, not silent success, when the stopped session exceeded the 12-hour cap', async () => {
      const { prisma, service } = build();
      await service.apply(USER, [
        { type: 'START_TIMER', payload: { taskName: 'Forgot to stop' } },
      ]);

      at('2026-08-12T23:30:00.000Z'); // 14.5 hours later
      const [result] = await service.apply(USER, [{ type: 'STOP_TIMER', payload: {} }]);

      expect(result.ok).toBe(true);
      expect(result.warning).toMatch(/12 hour/i);
      expect(result.resultId).toBe(prisma.timeEntries[0].id);
      // The write itself is still capped at 12h (720 minutes), same as the
      // manual stop path -- the warning is additive, not a substitute for
      // ActiveTimerService's own cap.
      expect(prisma.timeEntries[0].duration).toBe(720);
    });

    it('carries no warning on a normal-length session', async () => {
      const { service } = build();
      await service.apply(USER, [{ type: 'START_TIMER', payload: {} }]);

      at('2026-08-12T17:00:00.000Z'); // 8 hours
      const [result] = await service.apply(USER, [{ type: 'STOP_TIMER', payload: {} }]);

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });
});
