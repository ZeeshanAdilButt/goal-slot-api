import { ForbiddenException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { TimeEntriesService } from './time-entries.service';

// Regression cover for the time-entry IDOR.
//
// `create` and `update` wrote a client-supplied goalId / scheduleBlockId /
// taskId with no ownership check, and both respond with `include: { goal:
// true }`. Posting a victim's goalId returned that whole Goal (private ones
// included) and folded the attacker's minutes into the victim's loggedHours
// via GoalsService.updateProgress, which was itself unscoped.

const ATTACKER = 'attacker-user-id';
const VICTIM = 'victim-user-id';
const VICTIM_GOAL = 'victim-goal-id';
const VICTIM_BLOCK = 'victim-block-id';
const VICTIM_TASK = 'victim-task-id';
const OWN_GOAL = 'attacker-goal-id';
const OWN_ENTRY = 'attacker-entry-id';

interface Row {
  id: string;
  userId: string;
  [key: string]: any;
}

class FakePrisma {
  goals: Row[] = [
    { id: VICTIM_GOAL, userId: VICTIM, title: 'Secret', isPrivate: true },
    { id: OWN_GOAL, userId: ATTACKER, title: 'Mine' },
  ];
  scheduleBlocks: Row[] = [{ id: VICTIM_BLOCK, userId: VICTIM }];
  tasks: Row[] = [{ id: VICTIM_TASK, userId: VICTIM, title: 'Victim task' }];
  entries: Row[] = [
    { id: OWN_ENTRY, userId: ATTACKER, duration: 30, goalId: null },
  ];
  // create() now fetches the caller's own User row (concurrently with the
  // taskTitle lookup and the same-day count) so it can call
  // checkPlanLimitForUser without a second round-trip inside checkPlanLimit.
  users: Row[] = [
    { id: ATTACKER, userId: ATTACKER, plan: 'FREE' },
    { id: VICTIM, userId: VICTIM, plan: 'FREE' },
  ];

  created: any[] = [];
  updated: any[] = [];
  // Full call args (not just `data`), so tests can assert on `include`/
  // `select` shape without changing what create/update return.
  createCalls: any[] = [];
  updateCalls: any[] = [];

  private match(rows: Row[], where: any) {
    return (
      rows.find((r) =>
        Object.keys(where).every((k) => (where as any)[k] === r[k]),
      ) ?? null
    );
  }

  goal = {
    findFirst: async ({ where }: any) => this.match(this.goals, where),
    findUnique: async ({ where }: any) => this.match(this.goals, where),
    update: async () => ({}),
  };

  scheduleBlock = {
    findFirst: async ({ where }: any) => this.match(this.scheduleBlocks, where),
  };

  task = {
    findFirst: async ({ where }: any) => this.match(this.tasks, where),
  };

  user = {
    findUnique: async ({ where }: any) => this.match(this.users, where),
  };

  timeEntry = {
    findFirst: async ({ where }: any) => this.match(this.entries, where),
    count: async () => 0,
    create: async (args: any) => {
      this.createCalls.push(args);
      this.created.push(args.data);
      return { id: 'new-entry', ...args.data };
    },
    update: async (args: any) => {
      const { where, data } = args;
      this.updateCalls.push(args);
      this.updated.push({ where, data });
      return { id: where.id, ...data };
    },
    delete: async ({ where }: any) => {
      this.entries = this.entries.filter((e) => e.id !== where.id);
      return {};
    },
    aggregate: async () => ({ _sum: { duration: 0 } }),
  };
}

class FakeAuth {
  checkPlanLimit = async () => undefined;

  // Tracks whether/how often create()'s plan-limit check actually ran, and
  // lets tests force it to fail, so precedence between it and the
  // relation-ownership checks can be pinned directly (see the "error
  // precedence" describe block below) instead of only inferred from which
  // message came back.
  planLimitCalls = 0;
  planLimitExceeded = false;

  checkPlanLimitForUser = async (..._args: unknown[]) => {
    this.planLimitCalls++;
    if (this.planLimitExceeded) {
      throw new ForbiddenException('Plan limit reached');
    }
    return true;
  };
}

class FakeGoals {
  progressCalls: Array<{ goalId: string; userId: string }> = [];

  updateProgress = async (goalId: string, userId: string) => {
    this.progressCalls.push({ goalId, userId });
  };
}

function buildService() {
  const prisma = new FakePrisma();
  const goals = new FakeGoals();
  const auth = new FakeAuth();
  const service = new TimeEntriesService(
    prisma as any,
    auth as any,
    goals as any,
  );

  return { prisma, goals, auth, service };
}

const baseCreate = {
  taskName: 'Work',
  duration: 60,
  date: '2026-06-01',
};

describe('TimeEntriesService relation ownership', () => {
  it('refuses to create an entry against another user goal', async () => {
    const { prisma, goals, service } = buildService();

    await expect(
      service.create(ATTACKER, { ...baseCreate, goalId: VICTIM_GOAL } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Nothing written, and nothing read back out of the victim's account.
    expect(prisma.created).toHaveLength(0);
    expect(goals.progressCalls).toHaveLength(0);
  });

  it('refuses to create an entry against another user schedule block', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.create(ATTACKER, {
        ...baseCreate,
        scheduleBlockId: VICTIM_BLOCK,
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.created).toHaveLength(0);
  });

  it('refuses to create an entry against another user task even when taskTitle is supplied', async () => {
    const { prisma, service } = buildService();

    // taskTitle short-circuits the only pre-existing scoped task lookup, so
    // this is the path that used to sail straight through.
    await expect(
      service.create(ATTACKER, {
        ...baseCreate,
        taskId: VICTIM_TASK,
        taskTitle: 'anything',
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.created).toHaveLength(0);
  });

  it('refuses to repoint an owned entry at another user goal', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.update(ATTACKER, OWN_ENTRY, { goalId: VICTIM_GOAL } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.updated).toHaveLength(0);
  });

  it('still creates an entry linked to the caller own goal', async () => {
    const { prisma, goals, service } = buildService();

    const entry = await service.create(ATTACKER, {
      ...baseCreate,
      goalId: OWN_GOAL,
    } as any);

    expect(entry).toBeTruthy();
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0].userId).toBe(ATTACKER);
    expect(goals.progressCalls).toEqual([
      { goalId: OWN_GOAL, userId: ATTACKER },
    ]);
  });

  it('still creates an entry with no relations at all', async () => {
    const { prisma, service } = buildService();

    await service.create(ATTACKER, { ...baseCreate } as any);

    expect(prisma.created).toHaveLength(1);
  });

  it('passes the caller id through to updateProgress on delete', async () => {
    const { prisma, goals, service } = buildService();
    prisma.entries[0].goalId = OWN_GOAL;

    await service.delete(ATTACKER, OWN_ENTRY);

    expect(goals.progressCalls).toEqual([
      { goalId: OWN_GOAL, userId: ATTACKER },
    ]);
  });
});

// Pins the error precedence of create(): relation-ownership checks
// (validateRelations) and the plan-limit check both throw ForbiddenException,
// and used to be strictly ordered by sequential awaits (validateRelations
// fully resolves — and throws, if it's going to — before checkPlanLimit ever
// runs). Once validateRelations' three ownership checks and create()'s
// taskTitle/count/user lookups were each parallelised with Promise.all, nothing
// guarantees "first in source order" for free: Promise.all/race settle on
// whichever promise rejects first in wall-clock time, not array order. The
// fix keeps the two *stages* sequential (validateRelations is awaited to
// completion before the second Promise.all group even starts), so this test
// asserts the plan-limit check is never reached at all when a relation check
// is going to fail.
describe('TimeEntriesService error precedence', () => {
  it('throws the relation-ownership 403, not the plan-limit 403, when both would fail', async () => {
    const { prisma, auth, service } = buildService();
    auth.planLimitExceeded = true;

    await expect(
      service.create(ATTACKER, { ...baseCreate, goalId: VICTIM_GOAL } as any),
    ).rejects.toThrow('Goal not found or access denied');

    // The plan-limit check must never have run: proves validateRelations'
    // throw happened before create() even reached the stage that fetches the
    // user / calls checkPlanLimitForUser, not merely that it "won a race".
    expect(auth.planLimitCalls).toBe(0);
    expect(prisma.created).toHaveLength(0);
  });

  it('still enforces the plan-limit 403 when every relation check passes', async () => {
    const { prisma, auth, service } = buildService();
    auth.planLimitExceeded = true;

    await expect(
      service.create(ATTACKER, { ...baseCreate, goalId: OWN_GOAL } as any),
    ).rejects.toThrow('Plan limit reached');

    expect(auth.planLimitCalls).toBe(1);
    expect(prisma.created).toHaveLength(0);
  });
});

// Regression cover for the over-fetch fix: create/update used to say
// `include: { goal: true }`, pulling the entire Goal row (description,
// loggedHours, targetHours, deadline, templateId, ...) into every response
// even though callers only ever read id/title/color/category off it (see
// findByDateRange/getRecentEntries below, which already scoped their
// selects). Asserting the exact `select` shape here means a future revert
// back to `goal: true` fails this test instead of shipping unnoticed.
describe('TimeEntriesService goal over-fetch', () => {
  const GOAL_SELECT = {
    id: true,
    title: true,
    color: true,
    category: true,
  };

  it('create() selects only the fields the response actually uses off goal', async () => {
    const { prisma, service } = buildService();

    await service.create(ATTACKER, {
      ...baseCreate,
      goalId: OWN_GOAL,
    } as any);

    expect(prisma.createCalls).toHaveLength(1);
    expect(prisma.createCalls[0].include).toEqual({
      goal: { select: GOAL_SELECT },
    });
  });

  it('update() selects only the fields the response actually uses off goal', async () => {
    const { prisma, service } = buildService();
    prisma.entries[0].goalId = OWN_GOAL;

    await service.update(ATTACKER, OWN_ENTRY, { duration: 45 } as any);

    expect(prisma.updateCalls).toHaveLength(1);
    expect(prisma.updateCalls[0].include).toEqual({
      goal: { select: GOAL_SELECT },
    });
  });
});

// Regression cover for the missing-index fix: TimeEntry is filtered by
// `{ userId, date: {...} }` together in the overwhelming majority of hot-path
// queries (reports.service.ts, this service's own aggregates/list endpoints,
// the daily-entry-limit checks in tasks/active-timer, sharing.service.ts,
// coach-ai.service.ts) but previously only had separate single-column
// indexes on userId and on date. This checks the compound index is declared
// in the schema AND shipped as a committed migration, so a future schema
// edit that drops it (or a migration that never got generated) fails here
// instead of silently regressing query plans in production.
describe('TimeEntry userId+date compound index', () => {
  it('is declared on the TimeEntry model in schema.prisma', () => {
    const schema = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const model = schema.slice(
      schema.indexOf('model TimeEntry {'),
      schema.indexOf('// A timer that is currently running'),
    );

    expect(model).toContain('@@index([userId, date])');
  });

  it('ships a committed migration that creates the index', () => {
    const migrationsDir = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
    );
    const sql = fs
      .readdirSync(migrationsDir)
      .filter((entry) =>
        fs.existsSync(path.join(migrationsDir, entry, 'migration.sql')),
      )
      .map((entry) =>
        fs.readFileSync(
          path.join(migrationsDir, entry, 'migration.sql'),
          'utf8',
        ),
      )
      .join('\n');

    expect(sql).toContain(
      'CREATE INDEX "TimeEntry_userId_date_idx" ON "TimeEntry"("userId", "date")',
    );
  });
});
