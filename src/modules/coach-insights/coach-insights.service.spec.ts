import { ForbiddenException } from '@nestjs/common';
import { CoachInsightsService } from './coach-insights.service';

// Regression cover for a missing resource-exhaustion cap on Active
// Practices. createAccepted() (the CREATE_PRACTICE Coach action's target)
// had no plan-limit check at all, unlike its siblings goals/schedules/tasks
// — so a client hammering /coach/proposals/apply directly could create an
// unbounded number of CoachInsight rows regardless of plan. Mirrors the
// checkPlanLimit pattern already used by GoalsService/ScheduleService.

const USER = 'user-id';

class FakePrisma {
  creates: any[] = [];
  countArgs: any[] = [];
  activeCount = 0;

  coachInsight = {
    count: async ({ where }: any) => {
      this.countArgs.push(where);
      return this.activeCount;
    },
    create: async (args: any) => {
      this.creates.push(args);
      return { id: 'new-insight-id', ...args.data };
    },
  };
}

class FakeAuthService {
  calls: Array<{ userId: string; limitType: string; currentCount: number }> =
    [];
  limit = Infinity;

  async checkPlanLimit(
    userId: string,
    limitType: 'goals' | 'schedules' | 'tasksPerDay' | 'activePractices',
    currentCount: number,
  ) {
    this.calls.push({ userId, limitType, currentCount });
    if (currentCount >= this.limit) {
      throw new ForbiddenException(
        `You've reached your plan limit for ${limitType}.`,
      );
    }
    return true;
  }
}

function buildService(limit = Infinity) {
  const prisma = new FakePrisma();
  const authService = new FakeAuthService();
  authService.limit = limit;
  const service = new CoachInsightsService(prisma as any, authService as any);
  return { prisma, authService, service };
}

describe('CoachInsightsService.createAccepted plan limit', () => {
  it('counts only active-status insights, scoped to the caller, before checking the limit', async () => {
    const { prisma, authService } = buildService(20);
    prisma.activeCount = 5;

    await new CoachInsightsService(prisma as any, authService as any).createAccepted(
      USER,
      { title: 'Drink water', body: 'Drink 8 glasses a day' },
    );

    expect(prisma.countArgs[0]).toEqual({
      userId: USER,
      status: { in: ['PROPOSED', 'ACCEPTED', 'DOING'] },
    });
    expect(authService.calls).toEqual([
      { userId: USER, limitType: 'activePractices', currentCount: 5 },
    ]);
  });

  it('rejects and writes nothing once the active-practice limit is reached', async () => {
    const { prisma, service } = buildService(20);
    prisma.activeCount = 20;

    await expect(
      service.createAccepted(USER, {
        title: 'One too many',
        body: 'This should not be created',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.creates).toHaveLength(0);
  });

  it('creates normally when under the limit', async () => {
    const { prisma, service } = buildService(20);
    prisma.activeCount = 3;

    const created = await service.createAccepted(USER, {
      title: 'Stretch daily',
      body: '5 minutes every morning',
    });

    expect(created.id).toBe('new-insight-id');
    expect(prisma.creates).toHaveLength(1);
  });
});
