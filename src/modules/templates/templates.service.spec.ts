import { TemplatesService } from './templates.service';
import { APPROVED_TEMPLATES } from './templates.data';

// Regression cover for the template import wipe.
//
// `import` with `replaceExisting: true` ran deleteMany({ where: { userId } })
// on tasks, schedule blocks, and goals with no template filter. It destroyed
// every hand-created row the user owned, cascaded into GoalLabel and
// GoalReflection, and nulled goalId on every historical TimeEntry.

const USER = 'user-id';
const TEMPLATE = APPROVED_TEMPLATES[0];
const TEMPLATE_GOAL_ID = 'template-goal-id';

interface DeleteCall {
  model: string;
  where: any;
}

class FakeTx {
  deletes: DeleteCall[] = [];
  createdGoals: any[] = [];
  // Schedule blocks the user already owns, read back by `import`'s dedupe
  // pass. Tests seed this to stand in for a previous import of the same
  // template.
  existingBlocks: any[] = [];
  createdBlocks: any[] = [];

  goal = {
    deleteMany: async ({ where }: any) => {
      this.deletes.push({ model: 'goal', where });
      return { count: 0 };
    },
    findMany: async ({ where }: any) => {
      // Stands in for a prior import of this same template.
      if (where.templateId === TEMPLATE.id) {
        return [{ id: TEMPLATE_GOAL_ID, templateGoalRef: 'dsa' }];
      }
      return [];
    },
    createMany: async ({ data }: any) => {
      this.createdGoals.push(...data);
      return { count: data.length };
    },
  };

  scheduleBlock = {
    deleteMany: async ({ where }: any) => {
      this.deletes.push({ model: 'scheduleBlock', where });
      return { count: 0 };
    },
    findMany: async () => this.existingBlocks,
    createMany: async ({ data }: any) => {
      this.createdBlocks.push(...data);
      return { count: data.length };
    },
  };

  task = {
    deleteMany: async ({ where }: any) => {
      this.deletes.push({ model: 'task', where });
      return { count: 0 };
    },
    createMany: async ({ data }: any) => ({ count: data.length }),
  };
}

class FakePrisma {
  tx = new FakeTx();

  $transaction = async (fn: (tx: FakeTx) => Promise<any>) => fn(this.tx);
}

function buildService() {
  const prisma = new FakePrisma();
  const service = new TemplatesService(prisma as any);
  return { prisma, service };
}

describe('TemplatesService replaceExisting scope', () => {
  it('never deletes rows on userId alone', async () => {
    const { prisma, service } = buildService();

    await service.import(USER, TEMPLATE.id, {
      goals: true,
      schedule: true,
      tasks: true,
      replaceExisting: true,
    });

    expect(prisma.tx.deletes.length).toBeGreaterThan(0);
    for (const call of prisma.tx.deletes) {
      const keys = Object.keys(call.where);
      expect(keys).toContain('userId');
      // A where clause of just { userId } is the whole-account wipe.
      expect(keys.length).toBeGreaterThan(1);
    }
  });

  it('scopes the goal and task deletes to this template', async () => {
    const { prisma, service } = buildService();

    await service.import(USER, TEMPLATE.id, {
      goals: true,
      schedule: true,
      tasks: true,
      replaceExisting: true,
    });

    const goalDelete = prisma.tx.deletes.find((d) => d.model === 'goal');
    const taskDelete = prisma.tx.deletes.find((d) => d.model === 'task');

    expect(goalDelete!.where).toEqual({
      userId: USER,
      templateId: TEMPLATE.id,
    });
    expect(taskDelete!.where).toEqual({
      userId: USER,
      templateId: TEMPLATE.id,
    });
  });

  it('scopes the schedule block delete to goals from this template', async () => {
    const { prisma, service } = buildService();

    await service.import(USER, TEMPLATE.id, {
      goals: true,
      schedule: true,
      tasks: true,
      replaceExisting: true,
    });

    const blockDelete = prisma.tx.deletes.find(
      (d) => d.model === 'scheduleBlock',
    );

    expect(blockDelete!.where).toEqual({
      userId: USER,
      goalId: { in: [TEMPLATE_GOAL_ID] },
    });
  });

  it('deletes nothing when replaceExisting is not set', async () => {
    const { prisma, service } = buildService();

    await service.import(USER, TEMPLATE.id, {
      goals: true,
      schedule: true,
      tasks: true,
    });

    expect(prisma.tx.deletes).toHaveLength(0);
  });

  it('only deletes the sections actually being imported', async () => {
    const { prisma, service } = buildService();

    await service.import(USER, TEMPLATE.id, {
      goals: false,
      schedule: false,
      tasks: true,
      replaceExisting: true,
    });

    expect(prisma.tx.deletes.map((d) => d.model)).toEqual(['task']);
  });

  it('still stamps template provenance on the goals it creates, so the scoped delete has something to match', async () => {
    const { prisma, service } = buildService();

    const result = await service.import(USER, TEMPLATE.id, {
      goals: true,
      schedule: false,
      tasks: false,
    });

    expect(result.goalsCreated).toBeGreaterThan(0);
    for (const goal of prisma.tx.createdGoals) {
      expect(goal.templateId).toBe(TEMPLATE.id);
      expect(goal.templateGoalRef).toBeTruthy();
    }
  });
});

// Regression cover for template import duplicating schedule blocks.
//
// `import` wrote its blocks with a bare `tx.scheduleBlock.createMany(...)`:
// no conflict check, no idempotency key, and no unique constraint behind it,
// so re-importing a template inserted every one of its blocks a second time.
//
// `replaceExisting` did not save it either. The cleanup only deletes blocks
// whose goalId is one of this template's goals — ScheduleBlock has no
// templateId column — and a template block with no `goalRef` is written with
// `goalId: null`, so it is never deleted and duplicates on every re-import.
// The import now dedupes against the blocks the user already has, keyed on
// the same (dayOfWeek, startTime, endTime, title) tuple the diagnostic in
// scripts/find-duplicate-schedule-blocks.ts groups duplicates by.
describe('TemplatesService.import schedule block duplication', () => {
  const importSchedule = async (existingBlocks: any[]) => {
    const { prisma, service } = buildService();
    prisma.tx.existingBlocks = existingBlocks;
    const result = await service.import(USER, TEMPLATE.id, {
      goals: false,
      schedule: true,
      tasks: false,
    });
    return { prisma, result };
  };

  it('writes every block on a first import', async () => {
    const { prisma, result } = await importSchedule([]);

    expect(prisma.tx.createdBlocks).toHaveLength(TEMPLATE.schedule!.length);
    expect(result.scheduleBlocksCreated).toBe(TEMPLATE.schedule!.length);
  });

  // The bug itself: same template, imported twice, without replaceExisting.
  // Pre-fix this wrote a full second copy of every block.
  it('writes nothing on a re-import when the user already has every block', async () => {
    const existing = TEMPLATE.schedule!.map((b) => ({
      dayOfWeek: b.dayOfWeek,
      startTime: b.startTime,
      endTime: b.endTime,
      title: b.title,
    }));

    const { prisma, result } = await importSchedule(existing);

    expect(prisma.tx.createdBlocks).toHaveLength(0);
    expect(result.scheduleBlocksCreated).toBe(0);
  });

  it('writes only the blocks the user is actually missing', async () => {
    const [first, ...rest] = TEMPLATE.schedule!;
    const existing = [
      {
        dayOfWeek: first.dayOfWeek,
        startTime: first.startTime,
        endTime: first.endTime,
        title: first.title,
      },
    ];

    const { prisma } = await importSchedule(existing);

    expect(prisma.tx.createdBlocks).toHaveLength(rest.length);
    expect(
      prisma.tx.createdBlocks.some(
        (b) =>
          b.dayOfWeek === first.dayOfWeek &&
          b.startTime === first.startTime &&
          b.endTime === first.endTime &&
          b.title === first.title,
      ),
    ).toBe(false);
  });
});
