import { CoachProposalsService } from '../coach-proposals.service';
import { ScheduleService } from '../../schedule/schedule.service';

const USER = 'user-1';
const OTHER_USER = 'user-2';

/**
 * In-memory stand-in for PrismaService, scoped to what ScheduleService and
 * CoachProposalsService's UPDATE_SCHEDULE_BLOCK recovery path touch:
 * scheduleBlock.{count,findMany,findFirst,create,update,updateMany,delete}.
 */
class FakePrisma {
  blocks: Array<{
    id: string;
    userId: string;
    title: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    category: string | null;
    goalId: string | null;
    seriesId: string;
    isRecurring: boolean;
    isPrivate: boolean;
  }> = [];
  seq = 0;

  addBlock(overrides: Partial<(typeof this.blocks)[number]> = {}) {
    const id = overrides.id ?? `sb_${++this.seq}`;
    const row = {
      id,
      userId: USER,
      title: 'Deep Work',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
      category: 'DEEP_WORK',
      goalId: null,
      seriesId: `series_${id}`,
      isRecurring: false,
      isPrivate: false,
      ...overrides,
    };
    this.blocks.push(row);
    return row;
  }

  private withGoal(row: (typeof this.blocks)[number] | undefined) {
    if (!row) return null;
    return {
      ...row,
      goal: row.goalId ? { id: row.goalId, title: 'Some Goal' } : null,
    };
  }

  scheduleBlock = {
    count: async ({ where }: any) =>
      this.blocks.filter((b) => b.userId === where.userId).length,

    findMany: async ({ where }: any = {}) => {
      let rows = this.blocks;
      if (where?.userId !== undefined) {
        rows = rows.filter((b) => b.userId === where.userId);
      }
      if (where?.dayOfWeek !== undefined) {
        rows = rows.filter((b) => b.dayOfWeek === where.dayOfWeek);
      }
      if (where?.seriesId !== undefined) {
        rows = rows.filter((b) => b.seriesId === where.seriesId);
      }
      if (where?.id?.not !== undefined) {
        rows = rows.filter((b) => b.id !== where.id.not);
      }
      return rows.map((b) => ({ ...b }));
    },

    findFirst: async ({ where }: any) => {
      const row = this.blocks.find(
        (b) =>
          b.id === where.id &&
          (where.userId === undefined || b.userId === where.userId),
      );
      return this.withGoal(row);
    },

    create: async ({ data }: any) => {
      const row = this.addBlock(data);
      return this.withGoal(row);
    },

    update: async ({ where, data }: any) => {
      const row = this.blocks.find((b) => b.id === where.id);
      if (!row) {
        const err: any = new Error(
          'An operation failed because it depends on one or more records that were required but not found.',
        );
        err.code = 'P2025';
        throw err;
      }
      Object.assign(row, data);
      return this.withGoal(row);
    },

    updateMany: async ({ where, data }: any) => {
      const rows = this.blocks.filter(
        (b) => b.userId === where.userId && b.seriesId === where.seriesId,
      );
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },

    delete: async ({ where }: any) => {
      const idx = this.blocks.findIndex((b) => b.id === where.id);
      if (idx === -1) {
        const err: any = new Error('Record to delete does not exist.');
        err.code = 'P2025';
        throw err;
      }
      const [row] = this.blocks.splice(idx, 1);
      return row;
    },
  };
}

function buildServices() {
  const prisma = new FakePrisma();
  const authService = { checkPlanLimit: jest.fn().mockResolvedValue(undefined) };
  const schedule = new ScheduleService(prisma as any, authService as any);
  const service = new CoachProposalsService(
    prisma as any,
    {} as any, // GoalsService - unused by these tests
    schedule,
    {} as any, // TimeEntriesService - unused
    {} as any, // TasksService - unused
    {} as any, // CoachInsightsService - unused
  );
  return { prisma, service };
}

describe('CoachProposalsService - UPDATE_SCHEDULE_BLOCK stale id recovery', () => {
  it('applies a normal update against a valid, current id unaffected by the recovery path', async () => {
    const { prisma, service } = buildServices();
    const block = prisma.addBlock({
      title: 'Deep Work',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
    });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: block.id,
        payload: { startTime: '11:00', endTime: '16:00' },
      } as any,
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, resultId: block.id });
    const updated = prisma.blocks.find((b) => b.id === block.id)!;
    expect(updated.startTime).toBe('11:00');
    expect(updated.endTime).toBe('16:00');
  });

  it('recovers via a confident single match (expectedTitle + dayOfWeek) when the id is stale', async () => {
    const { prisma, service } = buildServices();
    // The block the Coach originally saw and built the proposal card against.
    const staleId = 'stale-id-not-in-db';
    // The user deleted that block and manually recreated it under a new id,
    // same title/day, slightly different time (simulating a manual edit).
    const recreated = prisma.addBlock({
      title: 'Deep Work',
      dayOfWeek: 1,
      startTime: '09:30',
      endTime: '10:30',
    });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: staleId,
        expectedTitle: 'Deep Work',
        payload: {
          dayOfWeek: 1,
          startTime: '11:00',
          endTime: '16:00',
        },
      } as any,
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, resultId: recreated.id });
    const updated = prisma.blocks.find((b) => b.id === recreated.id)!;
    expect(updated.startTime).toBe('11:00');
    expect(updated.endTime).toBe('16:00');
  });

  it('recovers a hallucinated/dead id on a bare rename using expectedTitle alone (no day/time in payload)', async () => {
    // Reproduces the live "rename Work to Work & Infra" bug: the model's text
    // reply named the block correctly, but the action's id didn't correspond
    // to any real block (empty/unrenderable card, 404 on apply). A plain
    // rename payload has no startTime/endTime/dayOfWeek to fall back on -
    // expectedTitle is the only thing that can recover it, and must.
    const { prisma, service } = buildServices();
    const work = prisma.addBlock({
      title: 'Work',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '17:00',
      category: 'DEEP_WORK',
    });
    // A decoy that must never be touched.
    prisma.addBlock({ title: 'Open Source', dayOfWeek: 2, startTime: '18:00', endTime: '19:00' });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: 'hallucinated-id-does-not-exist',
        expectedTitle: 'Work',
        payload: { title: 'Work & Infra' },
      } as any,
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, resultId: work.id });
    const updated = prisma.blocks.find((b) => b.id === work.id)!;
    expect(updated.title).toBe('Work & Infra');
  });

  it('recovers via dayOfWeek + overlapping current time window when no title is provided', async () => {
    const { prisma, service } = buildServices();
    const staleId = 'stale-id-2';
    const recreated = prisma.addBlock({
      title: 'Morning Block',
      dayOfWeek: 3,
      startTime: '10:30',
      endTime: '11:30',
    });
    // An unrelated block on a different day should never be considered.
    prisma.addBlock({ title: 'Other', dayOfWeek: 4, startTime: '10:30', endTime: '11:30' });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: staleId,
        // Requested window (11:00-16:00) overlaps the recreated block's
        // current window (10:30-11:30) on the same day.
        payload: { dayOfWeek: 3, startTime: '11:00', endTime: '16:00' },
      } as any,
    ]);

    expect(results[0]).toMatchObject({ ok: true, resultId: recreated.id });
  });

  it('fails cleanly with a specific message, not the generic one, when there is no identifying info at all', async () => {
    const { service } = buildServices();
    const staleId = 'stale-id-3';

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: staleId,
        // No expectedTitle, no dayOfWeek, no goalId - nothing to re-match on.
        payload: { startTime: '11:00', endTime: '16:00' },
      } as any,
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBeDefined();
    expect(results[0].error).not.toBe('Schedule block not found');
    expect(results[0].error).toMatch(/11:00-16:00/);
    expect(results[0].error).toMatch(/check your current schedule/i);
  });

  it('fails cleanly with a specific message when multiple blocks match ambiguously', async () => {
    const { prisma, service } = buildServices();
    const staleId = 'stale-id-4';
    // Two blocks share the same title + day at different times - title+day
    // alone can't disambiguate which one the Coach meant.
    prisma.addBlock({ title: 'Deep Work', dayOfWeek: 1, startTime: '09:00', endTime: '10:00' });
    prisma.addBlock({ title: 'Deep Work', dayOfWeek: 1, startTime: '14:00', endTime: '15:00' });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: staleId,
        expectedTitle: 'Deep Work',
        payload: { dayOfWeek: 1, startTime: '11:00', endTime: '12:00' },
      } as any,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/multiple blocks/i);
  });

  it('never matches on title alone when the title is only a loose/partial resemblance', async () => {
    // "Family Time" must never be picked for a request about "Dinner, Arabic
    // and Family time" - matching here is exact (normalized) only, never
    // substring or fuzzy.
    const { prisma, service } = buildServices();
    prisma.addBlock({ title: 'Family Time', dayOfWeek: 5, startTime: '05:00', endTime: '06:00' });
    prisma.addBlock({ title: 'FAMILY TIME', dayOfWeek: 0, startTime: '10:00', endTime: '11:00' });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: 'stale-loose-title',
        expectedTitle: 'Dinner, Arabic and Family time',
        payload: { startTime: '19:00', endTime: '20:00' },
      } as any,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/no longer exists/i);
  });

  it('rejects a weak-tier (goalId + dayOfWeek) resolution that lands on a block whose title disagrees with expectedTitle', async () => {
    // Belt-and-suspenders: goalId+dayOfWeek is a valid fallback tier for when
    // no title-based tier fires, but if expectedTitle was supplied it must
    // still be honored - a candidate from a weaker tier is re-checked against
    // it before being applied, not applied silently just because that tier
    // found exactly one hit.
    const { prisma, service } = buildServices();
    const decoy = prisma.addBlock({
      title: 'Unrelated Block',
      dayOfWeek: 3,
      startTime: '08:00',
      endTime: '09:00',
      goalId: 'goal-1',
    });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: 'stale-weak-tier',
        expectedTitle: 'Dinner, Arabic and Family time',
        payload: { dayOfWeek: 3, goalId: 'goal-1' },
      } as any,
    ]);

    expect(results[0].ok).toBe(false);
    const untouched = prisma.blocks.find((b) => b.id === decoy.id)!;
    expect(untouched.title).toBe('Unrelated Block');
  });

  it('never resolves on dayOfWeek alone when multiple differently-titled blocks share that day', async () => {
    // The exact shape of the "Dinner, Arabic and Family time ... Mon-Fri"
    // bug: several unrelated blocks share a day with the target. Without an
    // exact title match, dayOfWeek by itself must never pick one of them.
    const { prisma, service } = buildServices();
    prisma.addBlock({ title: 'LeafCompute', dayOfWeek: 4, startTime: '17:00', endTime: '19:00' });
    prisma.addBlock({ title: 'Read Paper and Take notes', dayOfWeek: 4, startTime: '09:00', endTime: '10:00' });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: 'stale-day-only',
        expectedTitle: 'Dinner, Arabic and Family time',
        payload: { dayOfWeek: 4, startTime: '19:00', endTime: '20:00' },
      } as any,
    ]);

    expect(results[0].ok).toBe(false);
  });

  it('does not throw out of apply() for a stale action, and does not affect other actions in the batch', async () => {
    const { prisma, service } = buildServices();
    const validBlockA = prisma.addBlock({ title: 'A', dayOfWeek: 0, startTime: '08:00', endTime: '09:00' });
    const validBlockB = prisma.addBlock({ title: 'B', dayOfWeek: 2, startTime: '08:00', endTime: '09:00' });
    const recreated = prisma.addBlock({ title: 'Recoverable', dayOfWeek: 5, startTime: '10:00', endTime: '11:00' });

    const actions = [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: validBlockA.id,
        payload: { startTime: '08:30', endTime: '09:30' },
      },
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: 'stale-no-hints',
        payload: { startTime: '11:00', endTime: '16:00' },
      },
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: validBlockB.id,
        payload: { startTime: '09:00', endTime: '09:30' },
      },
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: 'stale-with-hints',
        expectedTitle: 'Recoverable',
        payload: { dayOfWeek: 5, startTime: '12:00', endTime: '13:00' },
      },
    ];

    const resolved = await service.apply(USER, actions as any);

    expect(resolved).toHaveLength(4);
    expect(resolved[0]).toMatchObject({ index: 0, ok: true, resultId: validBlockA.id });
    expect(resolved[1]).toMatchObject({ index: 1, ok: false });
    expect(resolved[1].error).not.toBe('Schedule block not found');
    expect(resolved[2]).toMatchObject({ index: 2, ok: true, resultId: validBlockB.id });
    expect(resolved[3]).toMatchObject({ index: 3, ok: true, resultId: recreated.id });
  });

  it("does not resolve a stale id against another user's blocks", async () => {
    const { prisma, service } = buildServices();
    prisma.addBlock({
      userId: OTHER_USER,
      title: 'Deep Work',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
    });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: 'stale-cross-user',
        expectedTitle: 'Deep Work',
        payload: { dayOfWeek: 1, startTime: '11:00', endTime: '16:00' },
      } as any,
    ]);

    expect(results[0].ok).toBe(false);
  });
});

describe('CoachProposalsService - UPDATE_SCHEDULE_BLOCK wrong-block guard (valid id, wrong target)', () => {
  it('rejects an action whose id resolves but to a block with a different title than expected', async () => {
    // Reproduces the live "change Dinner, Arabic and Family time ... Monday
    // to Friday" bug: several of the proposed actions had ids that resolved
    // fine (schedule.update would have succeeded) but pointed at completely
    // unrelated blocks (LeafCompute, Read Paper and Take notes) that just
    // happened to sit on a requested day.
    const { prisma, service } = buildServices();
    const leafCompute = prisma.addBlock({
      title: 'LeafCompute',
      dayOfWeek: 4,
      startTime: '17:00',
      endTime: '19:00',
    });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: leafCompute.id,
        expectedTitle: 'Dinner, Arabic and Family time',
        payload: { startTime: '19:00', endTime: '20:00' },
      } as any,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/different block/i);
    // Nothing about the unrelated block was touched.
    const untouched = prisma.blocks.find((b) => b.id === leafCompute.id)!;
    expect(untouched.startTime).toBe('17:00');
    expect(untouched.endTime).toBe('19:00');
  });

  it('allows an action whose id resolves to a block matching expectedTitle exactly (case/whitespace-insensitive)', async () => {
    const { prisma, service } = buildServices();
    const block = prisma.addBlock({
      title: '  Dinner, Arabic and Family time  ',
      dayOfWeek: 1,
      startTime: '19:00',
      endTime: '21:00',
    });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: block.id,
        expectedTitle: 'dinner, arabic and family time',
        payload: { startTime: '19:00', endTime: '20:00' },
      } as any,
    ]);

    expect(results[0]).toMatchObject({ ok: true, resultId: block.id });
  });

  it('does not guard when the caller sends no expectedTitle (backward compatible, no regression)', async () => {
    const { prisma, service } = buildServices();
    const block = prisma.addBlock({
      title: 'Anything',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
    });

    const results = await service.apply(USER, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: block.id,
        payload: { startTime: '11:00', endTime: '12:00' },
      } as any,
    ]);

    expect(results[0]).toMatchObject({ ok: true, resultId: block.id });
  });
});
