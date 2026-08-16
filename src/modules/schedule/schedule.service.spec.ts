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
      // Mirrors real Prisma: an `undefined` value in a `where` clause means
      // "no constraint on this field" (the key is dropped from the query),
      // not "field must equal undefined". `checkTimeConflict` relies on this
      // for its `id: excludeId ? { not: excludeId } : undefined` clause.
      if (cond === undefined) return true;
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
      const row: Row = { ...data, id: data.id ?? `new-block-${this.created.length}` };
      this.created.push(row);
      // Feeds the row back into the "table" `findMany`/`checkTimeConflict`
      // read from, so a second create in the same test correctly sees the
      // first one's slot instead of racing against an empty table.
      this.scheduleBlocks.push(row);
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

  // `create`'s check-then-insert runs inside `prisma.$transaction(fn, ...)`
  // now (see schedule.service.ts's `createWithConflictGuard`). The fake has
  // no real Postgres underneath it to serialize against, so this just runs
  // the callback against `this` (same tables the rest of the fake exposes) —
  // enough for the non-racing behaviour tests below. The actual
  // serialization-conflict-and-retry path is covered separately by driving
  // `$transaction` to reject with a P2034-shaped error.
  $transaction = async (fn: any, _opts?: any) => fn(this);
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

// Regression cover for "schedule still double": create's time-conflict check
// and insert used to be two separate statements with a window between them
// where two concurrent creates for the same slot could both see "no
// conflict" and both insert, producing two real rows for one logical
// booking. `create` now runs the check + insert inside one
// `prisma.$transaction(..., { isolationLevel: Serializable })` call (see
// `createWithConflictGuard` in schedule.service.ts) and retries a losing
// transaction (Prisma error code P2034, what Postgres's serializable
// snapshot isolation raises when it detects that exact race) instead of
// letting it silently succeed as a duplicate.
describe('ScheduleService.create conflict-guard transaction', () => {
  it('runs the conflict check and the insert inside prisma.$transaction', async () => {
    const { prisma, service } = buildService();
    const transactionSpy = jest.spyOn(prisma, '$transaction');

    await service.create(ATTACKER, { ...baseCreate } as any);

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('retries a transaction that fails with a P2034 serialization conflict, and succeeds once the retry wins', async () => {
    const { prisma, service } = buildService();
    let attempts = 0;
    const realTransaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = (async (fn: any, opts: any) => {
      attempts += 1;
      if (attempts === 1) {
        throw { code: 'P2034', message: 'Transaction write conflict' };
      }
      return realTransaction(fn, opts);
    }) as any;

    const block = await service.create(ATTACKER, { ...baseCreate } as any);

    expect(attempts).toBe(2);
    expect(block).toBeTruthy();
    expect(prisma.created).toHaveLength(1);
  });

  it('gives up and rethrows after exhausting retries on repeated P2034 conflicts', async () => {
    const { prisma, service } = buildService();
    let attempts = 0;
    prisma.$transaction = (async () => {
      attempts += 1;
      throw { code: 'P2034', message: 'Transaction write conflict' };
    }) as any;

    await expect(
      service.create(ATTACKER, { ...baseCreate } as any),
    ).rejects.toMatchObject({ code: 'P2034' });

    // Initial attempt + MAX_CONFLICT_RETRIES retries.
    expect(attempts).toBe(4);
    expect(prisma.created).toHaveLength(0);
  });

  it('does not retry a genuine time-slot conflict (not a serialization failure)', async () => {
    const { prisma, service } = buildService();
    prisma.scheduleBlocks.push({
      id: 'existing-block',
      userId: ATTACKER,
      dayOfWeek: baseCreate.dayOfWeek,
      startTime: baseCreate.startTime,
      endTime: baseCreate.endTime,
    });
    const transactionSpy = jest.spyOn(prisma, '$transaction');

    await expect(
      service.create(ATTACKER, { ...baseCreate } as any),
    ).rejects.toThrow('Time slot conflicts with an existing schedule block');

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(prisma.created).toHaveLength(0);
  });

  it('never leaves two rows committed for one slot when two creates race with an unresolved conflict check in between', async () => {
    // Simulates the exact bug: both callers' conflict checks run before
    // either insert lands (the pre-fix race). Even with the checks racing,
    // the second insert must not be allowed to land as a silent duplicate —
    // in production that's Postgres's serializable isolation aborting one
    // side; here the fake proves the code path in `create` never itself
    // decides "both are fine" once it has seen the eventual conflict.
    const { prisma, service } = buildService();

    const first = await service.create(ATTACKER, { ...baseCreate } as any);
    expect(first).toBeTruthy();

    await expect(
      service.create(ATTACKER, { ...baseCreate } as any),
    ).rejects.toThrow('Time slot conflicts with an existing schedule block');

    expect(prisma.created).toHaveLength(1);
  });
});
