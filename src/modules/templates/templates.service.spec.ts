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
    create: async ({ data }: any) => {
      this.createdGoals.push(data);
      return { id: `${data.templateGoalRef}-new` };
    },
  };

  scheduleBlock = {
    deleteMany: async ({ where }: any) => {
      this.deletes.push({ model: 'scheduleBlock', where });
      return { count: 0 };
    },
    createMany: async ({ data }: any) => ({ count: data.length }),
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
