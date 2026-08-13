import { GoalStatus } from '@prisma/client';
import { GoalsService } from './goals.service';

// Regression cover for the unscoped goal-progress recompute.
//
// `updateProgress` looked the goal up with `findUnique({ where: { id } })`,
// no userId. The goalId reaching it comes from a client-supplied field on a
// time entry or a task, so anyone could drive a recompute on a stranger's
// goal, rewriting its loggedHours and flipping ACTIVE to COMPLETED.

const OWNER = 'owner-user-id';
const STRANGER = 'stranger-user-id';
const GOAL_ID = 'goal-id';

class FakePrisma {
  updates: any[] = [];
  findFirstArgs: any[] = [];

  goal = {
    findFirst: async ({ where }: any) => {
      this.findFirstArgs.push(where);
      if (where.id !== GOAL_ID) return null;
      if (where.userId !== undefined && where.userId !== OWNER) return null;
      return {
        id: GOAL_ID,
        userId: OWNER,
        targetHours: 10,
        status: GoalStatus.ACTIVE,
      };
    },
    findUnique: async () => {
      throw new Error(
        'updateProgress must not look a goal up without a userId scope',
      );
    },
    update: async (args: any) => {
      this.updates.push(args);
      return args;
    },
  };

  timeEntry = {
    aggregate: async () => ({ _sum: { duration: 6000 } }),
  };
}

function buildService() {
  const prisma = new FakePrisma();
  const service = new GoalsService(prisma as any, {} as any);
  return { prisma, service };
}

describe('GoalsService.updateProgress ownership scope', () => {
  it('does nothing when the goal belongs to somebody else', async () => {
    const { prisma, service } = buildService();

    await service.updateProgress(GOAL_ID, STRANGER);

    expect(prisma.updates).toHaveLength(0);
    expect(prisma.findFirstArgs[0]).toEqual({
      id: GOAL_ID,
      userId: STRANGER,
    });
  });

  it('recomputes loggedHours for the owner', async () => {
    const { prisma, service } = buildService();

    await service.updateProgress(GOAL_ID, OWNER);

    expect(prisma.updates).toHaveLength(1);
    expect(prisma.updates[0].data.loggedHours).toBe(100);
    // 100 logged against a 10 hour target still completes the goal.
    expect(prisma.updates[0].data.status).toBe(GoalStatus.COMPLETED);
  });
});
