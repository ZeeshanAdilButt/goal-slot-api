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

  it('rejects a second, later create for an already-taken slot (sequential — the check-then-insert already caught this pre-fix too)', async () => {
    // NOT a concurrency test — both calls are awaited one after the other,
    // so the second one's conflict check always sees the first's committed
    // row. This passes identically against the pre-fix code (two separate,
    // un-transacted statements): it only proves the ordinary non-racing
    // conflict path still works. The actual race is covered below, by a
    // fake that lets both transactions' reads genuinely interleave before
    // either commits.
    const { prisma, service } = buildService();

    const first = await service.create(ATTACKER, { ...baseCreate } as any);
    expect(first).toBeTruthy();

    await expect(
      service.create(ATTACKER, { ...baseCreate } as any),
    ).rejects.toThrow('Time slot conflicts with an existing schedule block');

    expect(prisma.created).toHaveLength(1);
  });

  it('genuinely closes the race when two creates for the same slot run concurrently, not sequentially', async () => {
    // `RacyFakePrisma` below is deliberately a SEPARATE, from-scratch fake
    // (not FakePrisma with $transaction swapped out) — it models just
    // enough of Postgres's serializable snapshot isolation to prove the
    // fix, rather than trusting a mock that's shaped to make the fix look
    // correct. Each transaction stamps the table's write-version at the
    // point it *reads* (checkTimeConflict); at *write* time (the insert),
    // if the version has moved since — meaning another transaction
    // committed in between — that's a genuine write-skew, and Postgres's
    // real serializable isolation would abort exactly one side with a
    // P2034-shaped error. `createWithConflictGuard`'s own `await` between
    // the read and the write (see schedule.service.ts) is what gives two
    // `Promise.all`-started calls a real interleaving point here: both
    // reach their read before either reaches its write, exactly like two
    // concurrent requests hitting the API at the same moment.
    const prisma = new RacyFakePrisma();
    const service = new ScheduleService(prisma as any, new FakeAuth() as any);

    const results = await Promise.allSettled([
      service.create(ATTACKER, { ...baseCreate } as any),
      service.create(ATTACKER, { ...baseCreate } as any),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Both callers' checks genuinely raced (see the fake's own comment) —
    // this is the exact scenario the pre-fix two-statement code would have
    // let both insert into. One must win, one must lose, and the loser's
    // retry (createWithConflictGuard catches the P2034 and tries again) has
    // to see the winner's now-committed row and reject with the ordinary
    // conflict message, not a raw retry-exhausted error.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason?.message).toContain(
      'Time slot conflicts with an existing schedule block',
    );
    expect(prisma.created).toHaveLength(1);
  });
});

/**
 * A from-scratch fake for the concurrency test above — see that test's own
 * comment for why this isn't just FakePrisma with `$transaction` patched.
 */
class RacyFakePrisma {
  scheduleBlocks: Row[] = [];
  created: Row[] = [];
  private tableVersion = 0;

  private matches(row: Row, where: Record<string, any>): boolean {
    return Object.keys(where).every((key) => {
      const cond = where[key];
      if (cond === undefined) return true;
      if (cond && typeof cond === 'object' && 'not' in cond) {
        return row[key] !== cond.not;
      }
      return row[key] === cond;
    });
  }

  // Read directly by `create()` before `createWithConflictGuard`/
  // `$transaction` is ever entered — goal ownership + plan-limit checks.
  goal = { findFirst: async () => null };
  scheduleBlock = {
    count: async () => 0,
    findFirst: async ({ where }: any) =>
      this.scheduleBlocks.find((b) => this.matches(b, where)) ?? null,
    findMany: async ({ where }: any) =>
      this.scheduleBlocks.filter((b) => this.matches(b, where)),
  };

  $transaction = async (fn: any, _opts?: any) => {
    const versionAtStart = this.tableVersion;
    const tx = {
      goal: this.goal,
      scheduleBlock: {
        ...this.scheduleBlock,
        create: async ({ data }: any) => {
          if (this.tableVersion !== versionAtStart) {
            // The write-skew: this transaction's read happened before the
            // table changed underneath it. Real Postgres would abort one
            // side of exactly this with a P2034 at commit time.
            throw { code: 'P2034', message: 'Transaction write conflict' };
          }
          const row: Row = {
            ...data,
            id: data.id ?? `racy-block-${this.created.length}`,
          };
          this.created.push(row);
          this.scheduleBlocks.push(row);
          this.tableVersion += 1;
          return row;
        },
      },
    };
    return fn(tx);
  };
}

// Regression cover for the ACTUAL "duplicate schedule blocks" root cause,
// which is not the race the block above fixes.
//
// `checkTimeConflict` compares raw minute offsets with no midnight
// wrap-around: `newStart < blockEnd && newEnd > blockStart`. For a block
// like 23:00-00:00 that is `1380 < 0` — false — even when compared against a
// byte-identical existing row. So the conflict check said "no conflict" and
// the duplicate inserted. This needs NO concurrency: it duplicates on two
// plainly sequential requests, which is precisely why the serializable
// transaction never closed it (a serializable transaction makes a check
// atomic; it cannot make a wrong check correct).
//
// `ScheduleService.assertValidRange` now rejects `endTime <= startTime` at
// the service level — the one choke point create, update and the Coach
// proposal path all share, and the only layer that also protects already
// installed mobile builds. Each of these tests inserts a real second row
// against the pre-fix code.
describe('ScheduleService inverted / zero-length time ranges', () => {
  const LATE = { ...baseCreate, startTime: '23:00', endTime: '00:00' };

  it('refuses to create a block whose end time wraps past midnight', async () => {
    const { prisma, service } = buildService();

    await expect(service.create(ATTACKER, { ...LATE } as any)).rejects.toThrow(
      'End time must be after start time',
    );

    expect(prisma.created).toHaveLength(0);
  });

  it('refuses to create a zero-length block', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.create(ATTACKER, {
        ...baseCreate,
        startTime: '09:00',
        endTime: '09:00',
      } as any),
    ).rejects.toThrow('End time must be after start time');

    expect(prisma.created).toHaveLength(0);
  });

  // The user-visible bug, stated exactly as the wife's iPhone produced it:
  // mobile quick-add used between 22:30 and 23:29 minted 23:00-00:00, which
  // renders as the entirely innocent-looking "11:00 PM - 12:00 AM". Pre-fix
  // this left TWO rows and `prisma.created` at length 1 (the second insert),
  // on top of the seeded one.
  it('does not insert a second copy of an existing block that wraps past midnight', async () => {
    const { prisma, service } = buildService();
    // A legacy inverted row already in the table — the shape that was
    // invisible to conflict detection and therefore duplicable without limit.
    prisma.scheduleBlocks.push({
      id: 'legacy-inverted-block',
      userId: ATTACKER,
      dayOfWeek: LATE.dayOfWeek,
      startTime: LATE.startTime,
      endTime: LATE.endTime,
      title: LATE.title,
    });

    await expect(service.create(ATTACKER, { ...LATE } as any)).rejects.toThrow(
      'End time must be after start time',
    );

    expect(prisma.created).toHaveLength(0);
    expect(
      prisma.scheduleBlocks.filter(
        (b) => b.startTime === '23:00' && b.endTime === '00:00',
      ),
    ).toHaveLength(1);
  });

  it('leaves only one row after two sequential identical late-night creates', async () => {
    const { prisma, service } = buildService();

    const outcomes = await Promise.allSettled([
      service.create(ATTACKER, { ...LATE } as any),
      service.create(ATTACKER, { ...LATE } as any),
    ]);

    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
    expect(prisma.created).toHaveLength(0);
  });

  it('refuses to edit a healthy block into an inverted range', async () => {
    // The worse half of the same defect: an ordinary 09:00-10:00 block could
    // be edited to start at 23:00, after which it overlapped nothing and
    // became duplicable. The DTO cannot catch this — UpdateScheduleBlockDto
    // is a PartialType, so the patch carries only `startTime` and the
    // inversion is only visible once merged with the stored row.
    const { prisma, service } = buildService();

    await expect(
      service.update(ATTACKER, OWN_BLOCK, { startTime: '23:00' } as any),
    ).rejects.toThrow('End time must be after start time');

    expect(prisma.updated).toHaveLength(0);
  });

  it('refuses to invert a whole series through a series-scope edit', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.update(ATTACKER, OWN_BLOCK, {
        startTime: '23:00',
        updateScope: 'series',
      } as any),
    ).rejects.toThrow('End time must be after start time');

    expect(prisma.updatedMany).toHaveLength(0);
  });

  // Guards the fix against over-rejecting: a block ending at 23:59 is a
  // perfectly ordinary late-evening block and must still go through.
  it('still allows a legitimate late block that ends before midnight', async () => {
    const { prisma, service } = buildService();

    await service.create(ATTACKER, {
      ...baseCreate,
      startTime: '23:00',
      endTime: '23:59',
    } as any);

    expect(prisma.created).toHaveLength(1);
  });

  it('still allows an ordinary edit that keeps the range valid', async () => {
    const { prisma, service } = buildService();

    await service.update(ATTACKER, OWN_BLOCK, { startTime: '09:30' } as any);

    expect(prisma.updated).toHaveLength(1);
  });
});
