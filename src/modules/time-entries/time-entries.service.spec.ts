import { ForbiddenException } from '@nestjs/common';
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

  created: any[] = [];
  updated: any[] = [];

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

  timeEntry = {
    findFirst: async ({ where }: any) => this.match(this.entries, where),
    count: async () => 0,
    create: async ({ data }: any) => {
      this.created.push(data);
      return { id: 'new-entry', ...data };
    },
    update: async ({ where, data }: any) => {
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
  const service = new TimeEntriesService(
    prisma as any,
    new FakeAuth() as any,
    goals as any,
  );

  return { prisma, goals, service };
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
