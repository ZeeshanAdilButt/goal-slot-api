import { CoachProposalsService } from '../coach-proposals.service';
import { ScheduleService } from '../../schedule/schedule.service';
import { CoachProposedAction } from '../dto/apply-proposals.dto';

/**
 * Deterministic schedule-editing scenarios for the Coach apply path.
 *
 * Every scenario runs the REAL CoachProposalsService and the REAL
 * ScheduleService (conflict checks, range checks, series updates, atomic
 * moves) against an in-memory table, so what is asserted here is what a user
 * actually sees after clicking Apply.
 *
 * The first scenario is the conversation that started this suite: replacing
 * "Reading & Labs (Core Engineering)" with two 30-minute blocks, where the
 * Coach's delete id matched no block, the delete reported success, and both
 * creates conflicted.
 */

const USER = 'user-1';
const OTHER = 'user-2';

type Row = {
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
};

class FakePrisma {
  blocks: Row[] = [];
  audit: Array<{
    userId: string;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata?: any;
  }> = [];
  seq = 0;

  add(
    o: Partial<Row> & {
      title: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
    },
  ): Row {
    const id =
      o.id ?? `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
    const row: Row = {
      userId: USER,
      category: 'LEARNING',
      goalId: null,
      seriesId: `series-${id}`,
      isRecurring: true,
      isPrivate: false,
      ...o,
      id,
    };
    this.blocks.push(row);
    return row;
  }

  /** Same title, start and end on several days, sharing one series. */
  addSeries(
    title: string,
    days: number[],
    startTime: string,
    endTime: string,
  ): Row[] {
    const seriesId = `series-${title}`;
    return days.map((d) =>
      this.add({ title, dayOfWeek: d, startTime, endTime, seriesId }),
    );
  }

  on(day: number, userId = USER) {
    return this.blocks
      .filter((b) => b.userId === userId && b.dayOfWeek === day)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .map((b) => `${b.startTime}-${b.endTime} ${b.title}`);
  }

  private match(b: Row, where: any = {}): boolean {
    if (where.userId !== undefined && b.userId !== where.userId) return false;
    if (where.dayOfWeek !== undefined && b.dayOfWeek !== where.dayOfWeek)
      return false;
    if (where.seriesId !== undefined && b.seriesId !== where.seriesId)
      return false;
    if (where.title !== undefined && b.title !== where.title) return false;
    if (where.startTime !== undefined && b.startTime !== where.startTime)
      return false;
    if (where.endTime !== undefined && b.endTime !== where.endTime)
      return false;
    if (typeof where.id === 'string' && b.id !== where.id) return false;
    if (where.id?.not !== undefined && b.id === where.id.not) return false;
    return true;
  }

  scheduleBlock = {
    count: async ({ where }: any) =>
      this.blocks.filter((b) => this.match(b, where)).length,
    findMany: async ({ where }: any = {}) =>
      this.blocks.filter((b) => this.match(b, where)).map((b) => ({ ...b })),
    findFirst: async ({ where }: any) => {
      const row = this.blocks.find((b) => this.match(b, where));
      return row ? { ...row, goal: null } : null;
    },
    create: async ({ data }: any) => ({ ...this.add(data), goal: null }),
    update: async ({ where, data }: any) => {
      const row = this.blocks.find((b) => b.id === where.id);
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
      Object.assign(row, data);
      return { ...row, goal: null };
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.blocks.filter((b) => this.match(b, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    delete: async ({ where }: any) => {
      const i = this.blocks.findIndex((b) => b.id === where.id);
      if (i === -1)
        throw Object.assign(new Error('not found'), { code: 'P2025' });
      return this.blocks.splice(i, 1)[0];
    },
  };

  auditLog = {
    create: async ({ data }: any) => {
      this.audit.push({ ...data });
      return data;
    },
    findMany: async ({ where }: any) =>
      this.audit.filter(
        (a) =>
          a.userId === where.userId &&
          a.action === where.action &&
          (where.entityId?.in ? where.entityId.in.includes(a.entityId) : true),
      ),
  };

  goal = { findFirst: async () => ({ id: 'goal' }) };

  /** Callback-style transaction that rolls the table back if it throws. */
  $transaction = async (fn: (tx: any) => Promise<any>) => {
    const snapshot = this.blocks.map((b) => ({ ...b }));
    try {
      return await fn(this);
    } catch (err) {
      this.blocks = snapshot;
      throw err;
    }
  };
}

function build() {
  const prisma = new FakePrisma();
  const schedule = new ScheduleService(
    prisma as any,
    {
      checkPlanLimit: jest.fn().mockResolvedValue(undefined),
    } as any,
  );
  const service = new CoachProposalsService(
    prisma as any,
    {} as any,
    schedule,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const apply = (actions: CoachProposedAction[], opts: any = {}) =>
    service.apply(USER, actions, opts);
  return { prisma, service, apply };
}

const del = (id: string, expectedTitle?: string): CoachProposedAction => ({
  type: 'DELETE_SCHEDULE_BLOCK',
  id,
  ...(expectedTitle ? { expectedTitle } : {}),
});
const create = (payload: Record<string, unknown>): CoachProposedAction => ({
  type: 'CREATE_SCHEDULE_BLOCK',
  payload: { category: 'LEARNING', ...payload },
});
const update = (
  id: string,
  expectedTitle: string,
  payload: Record<string, unknown>,
): CoachProposedAction => ({
  type: 'UPDATE_SCHEDULE_BLOCK',
  id,
  expectedTitle,
  payload,
});

/** The real shape of the account in the failing conversation (Tue and Thu only). */
function readingAndLabsWeek(prisma: FakePrisma) {
  const reading = prisma.addSeries(
    'Reading & Labs (Core Engineering)',
    [2, 4],
    '07:00',
    '09:00',
  );
  prisma.addSeries('Book', [2, 3, 4, 5], '09:00', '11:00');
  prisma.addSeries('Deen Lecture', [1, 2, 3, 4, 5], '06:00', '07:00');
  prisma.addSeries('Work', [1, 2, 3, 4, 5], '11:00', '16:00');
  return reading;
}

describe('Coach schedule scenarios: replace', () => {
  it('replaces one block with two in its own slot, even when the creates are listed first', async () => {
    const { prisma, apply } = build();
    const [tue] = readingAndLabsWeek(prisma);

    const results = await apply([
      create({
        title: 'Soft Skills',
        startTime: '07:00',
        endTime: '07:30',
        dayOfWeek: 2,
      }),
      create({
        title: 'Tech Labs',
        startTime: '07:30',
        endTime: '08:00',
        dayOfWeek: 2,
      }),
      del(tue.id, 'Reading & Labs (Core Engineering)'),
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(prisma.on(2)).toEqual([
      '06:00-07:00 Deen Lecture',
      '07:00-07:30 Soft Skills',
      '07:30-08:00 Tech Labs',
      '09:00-11:00 Book',
      '11:00-16:00 Work',
    ]);
  });

  it('replaces a recurring block on every day it occurs with one daysOfWeek create per new block', async () => {
    const { prisma, apply } = build();
    const [tue, thu] = readingAndLabsWeek(prisma);

    const results = await apply([
      del(tue.id, 'Reading & Labs (Core Engineering)'),
      del(thu.id, 'Reading & Labs (Core Engineering)'),
      create({
        title: 'Soft Skills',
        startTime: '07:00',
        endTime: '07:30',
        daysOfWeek: [2, 4],
      }),
      create({
        title: 'Tech Labs',
        startTime: '07:30',
        endTime: '08:00',
        daysOfWeek: [2, 4],
      }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    for (const d of [2, 4]) {
      expect(prisma.on(d)).toContain('07:00-07:30 Soft Skills');
      expect(prisma.on(d)).toContain('07:30-08:00 Tech Labs');
      expect(prisma.on(d).join()).not.toContain('Reading & Labs');
    }
    // The new blocks on both days share one series, so "do it on all days" later is one edit.
    const soft = prisma.blocks.filter((b) => b.title === 'Soft Skills');
    expect(new Set(soft.map((b) => b.seriesId)).size).toBe(1);
  });

  it('replaces only the days asked for and leaves the others alone', async () => {
    const { prisma, apply } = build();
    const [tue] = readingAndLabsWeek(prisma);

    await apply([
      del(tue.id, 'Reading & Labs (Core Engineering)'),
      create({
        title: 'Tech Labs',
        startTime: '07:00',
        endTime: '08:00',
        dayOfWeek: 2,
      }),
    ]);

    expect(prisma.on(4)).toContain(
      '07:00-09:00 Reading & Labs (Core Engineering)',
    );
    expect(prisma.on(2)).toContain('07:00-08:00 Tech Labs');
  });

  it('is idempotent: applying the same replacement twice changes nothing the second time', async () => {
    const { prisma, apply } = build();
    const [tue] = readingAndLabsWeek(prisma);
    const batch = [
      del(tue.id, 'Reading & Labs (Core Engineering)'),
      create({
        title: 'Soft Skills',
        startTime: '07:00',
        endTime: '07:30',
        dayOfWeek: 2,
      }),
    ];

    await apply(batch);
    const before = prisma.on(2);
    const again = await apply(batch);

    expect(again.every((r) => r.ok)).toBe(true);
    expect(again[0].alreadyDone).toBe(true);
    expect(prisma.on(2)).toEqual(before);
  });
});

describe("Coach schedule scenarios: a delete id that is not the user's (bug 1)", () => {
  it('refuses the whole batch, writes nothing, and says why, when the delete id matches no block', async () => {
    const { prisma, apply } = build();
    readingAndLabsWeek(prisma);
    const before = prisma.blocks.map((b) => ({ ...b }));

    // The exact shape of the live failure: a made-up id plus creates at a guessed time.
    const results = await apply([
      del(
        'b927183f-2111-4f25-853c-e6328939c640',
        'Reading & Labs (Core Engineering)',
      ),
      create({
        title: 'Soft Skills Development',
        startTime: '09:00',
        endTime: '09:30',
        dayOfWeek: 1,
      }),
      create({
        title: 'Tech Labs',
        startTime: '09:30',
        endTime: '10:00',
        dayOfWeek: 1,
      }),
    ]);

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toMatch(/not in your schedule/);
    expect(results[1]).toMatchObject({ ok: false, skipped: true });
    expect(results[2]).toMatchObject({ ok: false, skipped: true });
    expect(prisma.blocks).toEqual(before);
  });

  it('refuses a delete for a block that belongs to another user', async () => {
    const { prisma, apply } = build();
    const theirs = prisma.add({
      userId: OTHER,
      title: 'Theirs',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
    });

    const [r] = await apply([del(theirs.id)]);

    expect(r.ok).toBe(false);
    expect(prisma.blocks).toHaveLength(1);
  });

  it('refuses a delete whose id points at a different block than the Coach named', async () => {
    const { prisma, apply } = build();
    const book = prisma.add({
      title: 'Book',
      dayOfWeek: 2,
      startTime: '09:00',
      endTime: '11:00',
    });

    const [r] = await apply([
      del(book.id, 'Reading & Labs (Core Engineering)'),
    ]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different block than intended/);
    expect(prisma.blocks).toHaveLength(1);
  });

  it('does not count a re-apply as success when the block was deleted outside the Coach (no tombstone)', async () => {
    const { prisma, apply } = build();
    const b = prisma.add({
      title: 'Book',
      dayOfWeek: 2,
      startTime: '09:00',
      endTime: '11:00',
    });
    prisma.blocks = [];

    const [r] = await apply([del(b.id, 'Book')]);

    expect(r.ok).toBe(false);
  });

  it('writes a tombstone for every Coach delete', async () => {
    const { prisma, apply } = build();
    const b = prisma.add({
      title: 'Book',
      dayOfWeek: 2,
      startTime: '09:00',
      endTime: '11:00',
    });

    await apply([del(b.id, 'Book')]);

    expect(prisma.audit).toContainEqual(
      expect.objectContaining({
        action: 'coach.delete',
        entityType: 'ScheduleBlock',
        entityId: b.id,
      }),
    );
  });
});

describe('Coach schedule scenarios: move, conflicts and impossible requests', () => {
  it('moves a block into an empty slot', async () => {
    const { prisma, apply } = build();
    const b = prisma.add({
      title: 'Gym',
      dayOfWeek: 1,
      startTime: '18:00',
      endTime: '19:00',
    });

    const [r] = await apply([
      update(b.id, 'Gym', { startTime: '20:00', endTime: '21:00' }),
    ]);

    expect(r.ok).toBe(true);
    expect(prisma.on(1)).toEqual(['20:00-21:00 Gym']);
  });

  it('refuses a move into an occupied slot and names the block in the way', async () => {
    const { prisma, apply } = build();
    const gym = prisma.add({
      title: 'Gym',
      dayOfWeek: 1,
      startTime: '18:00',
      endTime: '19:00',
    });
    prisma.add({
      title: 'Dinner',
      dayOfWeek: 1,
      startTime: '19:00',
      endTime: '20:00',
    });

    const [r] = await apply([
      update(gym.id, 'Gym', { startTime: '19:00', endTime: '20:00' }),
    ]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"Dinner" \(Monday 7:00 PM to 8:00 PM\)/);
    expect(prisma.on(1)).toEqual(['18:00-19:00 Gym', '19:00-20:00 Dinner']);
  });

  it('applies a move into a conflict when the same proposal resolves it (shortens the other block)', async () => {
    const { prisma, apply } = build();
    const gym = prisma.add({
      title: 'Gym',
      dayOfWeek: 1,
      startTime: '18:00',
      endTime: '19:00',
    });
    const dinner = prisma.add({
      title: 'Dinner',
      dayOfWeek: 1,
      startTime: '19:00',
      endTime: '21:00',
    });

    const results = await apply([
      update(gym.id, 'Gym', { startTime: '19:00', endTime: '20:00' }),
      update(dinner.id, 'Dinner', { startTime: '20:00', endTime: '21:00' }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.on(1)).toEqual(['19:00-20:00 Gym', '20:00-21:00 Dinner']);
  });

  it('swaps two adjacent blocks atomically', async () => {
    const { prisma, apply } = build();
    const a = prisma.add({
      title: 'Deep Work',
      dayOfWeek: 3,
      startTime: '09:00',
      endTime: '10:00',
    });
    const b = prisma.add({
      title: 'Email',
      dayOfWeek: 3,
      startTime: '10:00',
      endTime: '11:00',
    });

    const results = await apply([
      update(a.id, 'Deep Work', { startTime: '10:00', endTime: '11:00' }),
      update(b.id, 'Email', { startTime: '09:00', endTime: '10:00' }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.on(3)).toEqual([
      '09:00-10:00 Email',
      '10:00-11:00 Deep Work',
    ]);
  });

  it('swaps blocks across days', async () => {
    const { prisma, apply } = build();
    const a = prisma.add({
      title: 'Gym',
      dayOfWeek: 1,
      startTime: '18:00',
      endTime: '19:00',
    });
    const b = prisma.add({
      title: 'Swim',
      dayOfWeek: 2,
      startTime: '18:00',
      endTime: '19:00',
    });
    prisma.add({
      title: 'Read',
      dayOfWeek: 1,
      startTime: '19:00',
      endTime: '20:00',
    });

    const results = await apply([
      update(a.id, 'Gym', { dayOfWeek: 2 }),
      update(b.id, 'Swim', { dayOfWeek: 1 }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.on(1)).toEqual(['18:00-19:00 Swim', '19:00-20:00 Read']);
    expect(prisma.on(2)).toEqual(['18:00-19:00 Gym']);
  });

  it('refuses end-before-start and explains midnight, writing nothing', async () => {
    const { prisma, apply } = build();

    const results = await apply([
      create({
        title: 'Late study',
        startTime: '23:00',
        endTime: '01:00',
        dayOfWeek: 5,
      }),
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/past midnight/);
    expect(prisma.blocks).toHaveLength(0);
  });

  it('refuses a zero-length block', async () => {
    const { apply } = build();
    const [r] = await apply([
      create({
        title: 'X',
        startTime: '10:00',
        endTime: '10:00',
        dayOfWeek: 1,
      }),
    ]);
    expect(r.error).toMatch(/End time must be after start time/);
  });

  it('accepts a past-midnight request split into two same-day blocks', async () => {
    const { prisma, apply } = build();
    const results = await apply([
      create({
        title: 'Late study',
        startTime: '23:00',
        endTime: '23:59',
        dayOfWeek: 5,
      }),
      create({
        title: 'Late study',
        startTime: '00:00',
        endTime: '01:00',
        dayOfWeek: 6,
      }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.blocks).toHaveLength(2);
  });

  it('refuses two new blocks in the same proposal that overlap each other', async () => {
    const { prisma, apply } = build();
    const results = await apply([
      create({
        title: 'A',
        startTime: '09:00',
        endTime: '10:00',
        dayOfWeek: 1,
      }),
      create({
        title: 'B',
        startTime: '09:30',
        endTime: '10:30',
        dayOfWeek: 1,
      }),
    ]);
    expect(results[1].error).toMatch(/which this same proposal also adds/);
    expect(prisma.blocks).toHaveLength(0);
  });

  it('refuses a multi-day create when one day has no room, and names the day and the block', async () => {
    const { prisma, apply } = build();
    prisma.add({
      title: 'Standup',
      dayOfWeek: 3,
      startTime: '09:00',
      endTime: '09:15',
    });

    const [r] = await apply([
      create({
        title: 'Deep Work',
        startTime: '09:00',
        endTime: '11:00',
        daysOfWeek: [1, 2, 3, 4, 5],
      }),
    ]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(
      /Wednesday 9:00 AM to 11:00 AM would overlap "Standup"/,
    );
    expect(prisma.blocks).toHaveLength(1);
  });

  it('does not let a pre-existing overlap elsewhere block an unrelated change', async () => {
    const { prisma, apply } = build();
    prisma.add({
      title: 'Old A',
      dayOfWeek: 0,
      startTime: '09:00',
      endTime: '10:00',
    });
    prisma.add({
      title: 'Old B',
      dayOfWeek: 0,
      startTime: '09:30',
      endTime: '10:30',
    });

    const [r] = await apply([
      create({
        title: 'New',
        startTime: '12:00',
        endTime: '13:00',
        dayOfWeek: 0,
      }),
    ]);

    expect(r.ok).toBe(true);
  });
});

describe('Coach schedule scenarios: split, merge, shorten, extend', () => {
  it('splits a block into two by shortening it and adding the second half', async () => {
    const { prisma, apply } = build();
    const b = prisma.add({
      title: 'Deep Work',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '11:00',
    });

    const results = await apply([
      update(b.id, 'Deep Work', { endTime: '10:00' }),
      create({
        title: 'Code Review',
        startTime: '10:00',
        endTime: '11:00',
        dayOfWeek: 1,
      }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.on(1)).toEqual([
      '09:00-10:00 Deep Work',
      '10:00-11:00 Code Review',
    ]);
  });

  it('splits even when the create is listed before the shortening update', async () => {
    const { prisma, apply } = build();
    const b = prisma.add({
      title: 'Deep Work',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '11:00',
    });

    const results = await apply([
      create({
        title: 'Code Review',
        startTime: '10:00',
        endTime: '11:00',
        dayOfWeek: 1,
      }),
      update(b.id, 'Deep Work', { endTime: '10:00' }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.on(1)).toEqual([
      '09:00-10:00 Deep Work',
      '10:00-11:00 Code Review',
    ]);
  });

  it('merges two adjacent blocks by deleting one and extending the other', async () => {
    const { prisma, apply } = build();
    const a = prisma.add({
      title: 'Reading',
      dayOfWeek: 2,
      startTime: '07:00',
      endTime: '08:00',
    });
    const b = prisma.add({
      title: 'Labs',
      dayOfWeek: 2,
      startTime: '08:00',
      endTime: '09:00',
    });

    const results = await apply([
      update(a.id, 'Reading', { endTime: '09:00', title: 'Reading & Labs' }),
      del(b.id, 'Labs'),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.on(2)).toEqual(['07:00-09:00 Reading & Labs']);
  });

  it('extends a block into free time, and refuses extending it into the next block', async () => {
    const { prisma, apply } = build();
    const a = prisma.add({
      title: 'Deep Work',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
    });
    prisma.add({
      title: 'Lunch',
      dayOfWeek: 1,
      startTime: '12:00',
      endTime: '13:00',
    });

    expect(
      (await apply([update(a.id, 'Deep Work', { endTime: '12:00' })]))[0].ok,
    ).toBe(true);
    const [bad] = await apply([
      update(a.id, 'Deep Work', { endTime: '12:30' }),
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/"Lunch"/);
    expect(prisma.on(1)).toEqual([
      '09:00-12:00 Deep Work',
      '12:00-13:00 Lunch',
    ]);
  });

  it('shortens a whole recurring series with one series-scoped update', async () => {
    const { prisma, apply } = build();
    const [mon] = prisma.addSeries('Work', [1, 2, 3, 4, 5], '11:00', '16:00');

    const [r] = await apply([
      update(mon.id, 'Work', { endTime: '15:00', updateScope: 'series' }),
    ]);

    expect(r.ok).toBe(true);
    for (const d of [1, 2, 3, 4, 5])
      expect(prisma.on(d)).toEqual(['11:00-15:00 Work']);
  });

  it('refuses a series-scoped extension that collides on one of the days', async () => {
    const { prisma, apply } = build();
    const [mon] = prisma.addSeries('Work', [1, 2, 3], '11:00', '16:00');
    prisma.add({
      title: 'Community Time',
      dayOfWeek: 3,
      startTime: '16:00',
      endTime: '17:00',
    });

    const [r] = await apply([
      update(mon.id, 'Work', { endTime: '17:00', updateScope: 'series' }),
    ]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Wednesday .* "Community Time"/);
    expect(prisma.on(1)).toEqual(['11:00-16:00 Work']);
  });
});

describe('Coach schedule scenarios: range requests and same-name blocks', () => {
  it('"clear my Friday afternoon" deletes exactly the afternoon blocks', async () => {
    const { prisma, apply } = build();
    prisma.add({
      title: 'Standup',
      dayOfWeek: 5,
      startTime: '09:00',
      endTime: '09:15',
    });
    const a = prisma.add({
      title: 'Review',
      dayOfWeek: 5,
      startTime: '13:00',
      endTime: '14:00',
    });
    const b = prisma.add({
      title: 'Planning',
      dayOfWeek: 5,
      startTime: '15:00',
      endTime: '16:30',
    });

    const results = await apply([del(a.id, 'Review'), del(b.id, 'Planning')]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.on(5)).toEqual(['09:00-09:15 Standup']);
  });

  it('deletes only the named occurrence when several blocks share a title', async () => {
    const { prisma, apply } = build();
    const [, tue] = prisma.addSeries(
      'Family Time',
      [1, 2, 3],
      '05:00',
      '06:00',
    );

    await apply([del(tue.id, 'Family Time')]);

    expect(prisma.on(1)).toEqual(['05:00-06:00 Family Time']);
    expect(prisma.on(2)).toEqual([]);
    expect(prisma.on(3)).toEqual(['05:00-06:00 Family Time']);
  });

  it('never treats a similar title as the same block', async () => {
    const { prisma, apply } = build();
    const fam = prisma.add({
      title: 'Family Time',
      dayOfWeek: 1,
      startTime: '05:00',
      endTime: '06:00',
    });

    const [r] = await apply([del(fam.id, 'Dinner, Arabic and Family time')]);

    expect(r.ok).toBe(false);
    expect(prisma.blocks).toHaveLength(1);
  });
});

describe('Coach schedule scenarios: large weeks and $refs', () => {
  it('applies a 10-delete clean-up (the unconfirmed cap) and refuses 11', async () => {
    const { prisma, apply } = build();
    const rows = Array.from({ length: 11 }, (_, i) =>
      prisma.add({
        title: `B${i}`,
        dayOfWeek: i % 7,
        startTime: `${String(6 + Math.floor(i / 7) * 2).padStart(2, '0')}:00`,
        endTime: `${String(7 + Math.floor(i / 7) * 2).padStart(2, '0')}:00`,
      }),
    );

    const ten = await apply(rows.slice(0, 10).map((r) => del(r.id, r.title)));
    expect(ten.every((r) => r.ok)).toBe(true);

    const p2 = build();
    const rows2 = rows.map((r) => p2.prisma.add({ ...r }));
    await expect(
      p2.apply(rows2.map((r) => del(r.id, r.title))),
    ).rejects.toThrow(/11 delete actions/);
    // A client that confirms every id (web since goal-slot-web#327) gets all 11 through.
    const confirmed = await p2.apply(
      rows2.map((r) => del(r.id, r.title)),
      {
        confirmedDeleteIds: rows2.map((r) => r.id),
      },
    );
    expect(confirmed.every((r) => r.ok)).toBe(true);
  });

  it('builds a dense 7-day week from 14 multi-day creates without a single conflict', async () => {
    const { prisma, apply } = build();
    const all = [0, 1, 2, 3, 4, 5, 6];
    const actions = Array.from({ length: 14 }, (_, h) =>
      create({
        title: `Slot ${h}`,
        startTime: `${String(6 + h).padStart(2, '0')}:00`,
        endTime: `${String(7 + h).padStart(2, '0')}:00`,
        daysOfWeek: all,
      }),
    );

    const results = await apply(actions);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.blocks).toHaveLength(98);
  });

  it('runs a $ref dependant after the action it points at, even when deletes jump the queue', async () => {
    const { prisma, service } = build();
    const goals = {
      create: jest
        .fn()
        .mockResolvedValue({ id: '9f1c2c80-0000-4000-8000-000000000001' }),
    };
    (service as any).goals = goals;
    const old = prisma.add({
      title: 'Old',
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '10:00',
    });

    const results = await service.apply(USER, [
      {
        type: 'CREATE_GOAL',
        payload: { title: 'Labs', category: 'LEARNING', targetHours: 10 },
      },
      create({
        title: 'Labs',
        startTime: '09:00',
        endTime: '10:00',
        dayOfWeek: 1,
        goalId: '$ref:0',
      }),
      del(old.id, 'Old'),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(prisma.blocks.find((b) => b.title === 'Labs')?.goalId).toBe(
      '9f1c2c80-0000-4000-8000-000000000001',
    );
  });
});

describe('Coach schedule scenarios: the apply log the Coach reads next turn', () => {
  it('records the outcome of each action against the source message', async () => {
    const { prisma, apply } = build();
    readingAndLabsWeek(prisma);

    await apply(
      [
        del(
          'a8bddb4f-3dcd-4e82-970e-99f7b3d5316b',
          'Reading & Labs (Core Engineering)',
        ),
        create({
          title: 'Tech Labs',
          startTime: '13:30',
          endTime: '14:00',
          dayOfWeek: 1,
        }),
      ],
      { sourceMessageId: 'msg-1' },
    );

    const log = prisma.audit.find((a) => a.action === 'coach.apply');
    expect(log).toMatchObject({
      entityType: 'CoachMessage',
      entityId: 'msg-1',
    });
    expect(log!.metadata.outcome).toBe('refused');
    expect(log!.metadata.results[0]).toMatchObject({
      ok: false,
      label: 'Delete "Reading & Labs (Core Engineering)"',
    });
    // The create at 1:30 PM Monday would have hit Work; it is reported, not swallowed.
    expect(log!.metadata.results[1].label).toBe(
      'Add "Tech Labs" Mon 1:30 PM to 2:00 PM',
    );
  });

  it('names the conflicting block when a create collides with an existing one', async () => {
    const { prisma, apply } = build();
    readingAndLabsWeek(prisma);

    const [r] = await apply([
      create({
        title: 'Tech Labs',
        startTime: '13:30',
        endTime: '14:00',
        dayOfWeek: 1,
      }),
    ]);

    expect(r.error).toMatch(/"Work" \(Monday 11:00 AM to 4:00 PM\)/);
  });
});

describe('Coach schedule scenarios: a mistyped block id', () => {
  it('repairs an id one character off when exactly one block with that title is that close', async () => {
    const { prisma, apply } = build();
    const sat = prisma.add({
      id: 'dd271118-e27e-4595-a9e4-dcd66a7dc84f',
      title: 'Community Time',
      dayOfWeek: 6,
      startTime: '16:00',
      endTime: '17:00',
    });
    prisma.add({
      id: '3a4b1b2c-91d0-4c3e-8f7a-5e2b9c1d0a77',
      title: 'Community Time',
      dayOfWeek: 0,
      startTime: '16:00',
      endTime: '17:00',
    });

    const [r] = await apply([del(sat.id.slice(0, -1), 'Community Time')]);

    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/mistyped/);
    expect(prisma.on(6)).toEqual([]);
    expect(prisma.on(0)).toEqual(['16:00-17:00 Community Time']);
  });

  it('still refuses a fabricated id, even with a real title', async () => {
    const { prisma, apply } = build();
    prisma.add({
      title: 'Community Time',
      dayOfWeek: 6,
      startTime: '16:00',
      endTime: '17:00',
    });

    const [r] = await apply([
      del('27aa93aa-fbcb-4ad1-a602-a394e646f0c2', 'Community Time'),
    ]);

    expect(r.ok).toBe(false);
    expect(prisma.blocks).toHaveLength(1);
  });

  it('does not repair when the title does not match the near-miss block', async () => {
    const { prisma, apply } = build();
    const b = prisma.add({
      title: 'Book',
      dayOfWeek: 2,
      startTime: '09:00',
      endTime: '11:00',
    });

    const [r] = await apply([del(b.id.slice(0, -1), 'Community Time')]);

    expect(r.ok).toBe(false);
    expect(prisma.blocks).toHaveLength(1);
  });
});
