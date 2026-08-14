import { ForbiddenException } from '@nestjs/common';
import { ScheduleService } from './schedule.service';

// Regression cover for the schedule-block goal IDOR.
//
// `create` and `update` wrote a client-supplied goalId onto a schedule block
// with no ownership check, and both respond with `include: { goal: true }`.
// Posting a victim's goalId linked the caller's own block to that goal and
// read the whole Goal back out in the response. Mirrors the same guard
// already applied in TasksService.validateRelations and
// TimeEntriesService.validateRelations for the identical relation.

const ATTACKER = 'attacker-user-id';
const VICTIM = 'victim-user-id';
const VICTIM_GOAL = 'victim-goal-id';
const OWN_GOAL = 'attacker-goal-id';
const OWN_BLOCK = 'attacker-block-id';
const SERIES_ID = 'series-id';

interface Row {
  id: string;
  userId: string;
  [key: string]: unknown;
}

class FakePrisma {
  goals: Row[] = [
    { id: VICTIM_GOAL, userId: VICTIM, title: 'Secret goal' },
    { id: OWN_GOAL, userId: ATTACKER, title: 'My goal' },
  ];

  scheduleBlocks: Row[] = [
    {
      id: OWN_BLOCK,
      userId: ATTACKER,
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
      seriesId: SERIES_ID,
      goalId: null,
    },
  ];

  created: Row[] = [];
  updated: Array<{ where: any; data: any }> = [];
  updatedMany: Array<{ where: any; data: any }> = [];

  private matches(row: Row, where: Record<string, any>): boolean {
    return Object.keys(where).every((key) => {
      const cond = where[key];
      if (cond && typeof cond === 'object' && 'not' in cond) {
        return row[key] !== cond.not;
      }
      return row[key] === cond;
    });
  }

  goal = {
    findFirst: async ({ where }: any) =>
      this.goals.find((g) => this.matches(g, where)) ?? null,
  };

  scheduleBlock = {
    count: async () => 0,
    findFirst: async ({ where }: any) =>
      this.scheduleBlocks.find((b) => this.matches(b, where)) ?? null,
    findMany: async ({ where }: any) =>
      this.scheduleBlocks.filter((b) => this.matches(b, where)),
    create: async ({ data }: any) => {
      const row: Row = { id: 'new-block', ...data };
      this.created.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      this.updated.push({ where, data });
      return { ...where, ...data };
    },
    updateMany: async ({ where, data }: any) => {
      this.updatedMany.push({ where, data });
      return { count: 0 };
    },
  };
}

class FakeAuth {
  checkPlanLimit = async () => undefined;
}

function buildService() {
  const prisma = new FakePrisma();
  const service = new ScheduleService(prisma as any, new FakeAuth() as any);
  return { prisma, service };
}

const baseCreate = {
  title: 'Deep Work',
  startTime: '11:00',
  endTime: '12:00',
  dayOfWeek: 2,
  category: 'WORK',
};

describe('ScheduleService goal ownership', () => {
  it('refuses to create a block linked to another user goal', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.create(ATTACKER, {
        ...baseCreate,
        goalId: VICTIM_GOAL,
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.created).toHaveLength(0);
  });

  it('refuses to repoint an owned block at another user goal (single scope)', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.update(ATTACKER, OWN_BLOCK, { goalId: VICTIM_GOAL } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.updated).toHaveLength(0);
  });

  it('refuses to repoint a whole series at another user goal', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.update(ATTACKER, OWN_BLOCK, {
        goalId: VICTIM_GOAL,
        updateScope: 'series',
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.updatedMany).toHaveLength(0);
  });

  it('still creates a block linked to the caller own goal', async () => {
    const { prisma, service } = buildService();

    const block = await service.create(ATTACKER, {
      ...baseCreate,
      goalId: OWN_GOAL,
    } as any);

    expect(block).toBeTruthy();
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0].userId).toBe(ATTACKER);
    expect(prisma.created[0].goalId).toBe(OWN_GOAL);
  });

  it('still creates a block with no goal at all', async () => {
    const { prisma, service } = buildService();

    await service.create(ATTACKER, { ...baseCreate } as any);

    expect(prisma.created).toHaveLength(1);
  });

  it('still updates an owned block onto the caller own goal', async () => {
    const { prisma, service } = buildService();

    await service.update(ATTACKER, OWN_BLOCK, { goalId: OWN_GOAL } as any);

    expect(prisma.updated).toHaveLength(1);
    expect(prisma.updated[0].data.goalId).toBe(OWN_GOAL);
  });
});
