import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
  deleted: Row[] = [];
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
      if (cond && typeof cond === 'object' && 'in' in cond) {
        return (cond.in as unknown[]).includes(row[key]);
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
      const row: Row = {
        ...data,
        id: data.id ?? `new-block-${this.created.length}`,
      };
      this.created.push(row);
      // Feeds the row back into the "table" `findMany`/`checkTimeConflict`
      // read from, so a second create in the same test correctly sees the
      // first one's slot instead of racing against an empty table.
      this.scheduleBlocks.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      this.updated.push({ where, data });
      // Applied to the stored row too, so a later read in the same
      // transaction sees it (the set-days tests read the series back).
      const row = this.scheduleBlocks.find((b) => b.id === where.id);
      if (row) Object.assign(row, data);
      return { ...where, ...data };
    },
    deleteMany: async ({ where }: any) => {
      const doomed = this.scheduleBlocks.filter((b) => this.matches(b, where));
      this.deleted.push(...doomed);
      this.scheduleBlocks = this.scheduleBlocks.filter(
        (b) => !doomed.includes(b),
      );
      return { count: doomed.length };
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

// Regression cover for the multi-day fan-out bug: the web client used to send
// N parallel `POST /schedule` requests (one per selected day, sharing a
// seriesId) via `Promise.all`. That fails fast on the first rejection, but
// the OTHER requests were already in flight and completed independently —
// nothing spanned the group. A genuine conflict on one day 400'd, the user
// saw ONE error and assumed nothing happened, while up to N-1 blocks were
// silently created. `ScheduleService.createBatch` /
// `createBatchWithConflictGuard` fix this the same way `createWithConflictGuard`
// closes the single-block race: every day is checked for a conflict BEFORE
// any day is inserted, all inside one Serializable transaction, so a
// conflict anywhere rolls back the whole group.
describe('ScheduleService.createBatch atomic group create', () => {
  const monday = { ...baseCreate, dayOfWeek: 1, seriesId: SERIES_ID };
  const wednesday = { ...baseCreate, dayOfWeek: 3, seriesId: SERIES_ID };
  const friday = { ...baseCreate, dayOfWeek: 5, seriesId: SERIES_ID };

  it('creates all N rows when every day is conflict-free', async () => {
    const { prisma, service } = buildService();

    const result = await service.createBatch(ATTACKER, {
      blocks: [monday, wednesday, friday] as any,
    });

    expect(result).toHaveLength(3);
    expect(prisma.created).toHaveLength(3);
    expect(prisma.created.map((b) => b.dayOfWeek).sort()).toEqual([1, 3, 5]);
    expect(prisma.created.every((b) => b.seriesId === SERIES_ID)).toBe(true);
  });

  it('rolls back the ENTIRE batch when just one day genuinely conflicts — row count stays unchanged, not N-1', async () => {
    const { prisma, service } = buildService();
    // Wednesday already has a block sitting in this exact slot.
    prisma.scheduleBlocks.push({
      id: 'existing-wed-block',
      userId: ATTACKER,
      dayOfWeek: 3,
      startTime: baseCreate.startTime,
      endTime: baseCreate.endTime,
    });

    await expect(
      service.createBatch(ATTACKER, {
        blocks: [monday, wednesday, friday] as any,
      }),
    ).rejects.toThrow(
      'Time slot conflicts with an existing schedule block on Wednesday',
    );

    // Zero rows created — NOT 2 (Monday and Friday, which had no conflict of
    // their own, must not have been left behind either).
    expect(prisma.created).toHaveLength(0);
  });

  it('identifies the specific conflicting day by name in the error message', async () => {
    const { prisma, service } = buildService();
    prisma.scheduleBlocks.push({
      id: 'existing-fri-block',
      userId: ATTACKER,
      dayOfWeek: 5,
      startTime: baseCreate.startTime,
      endTime: baseCreate.endTime,
    });

    await expect(
      service.createBatch(ATTACKER, {
        blocks: [monday, wednesday, friday] as any,
      }),
    ).rejects.toThrow('Friday');
  });

  it('rejects (and creates nothing) when two entries in the SAME request overlap on the same day, before ever touching the DB', async () => {
    const { prisma, service } = buildService();
    const overlappingMonday = {
      ...baseCreate,
      dayOfWeek: 1,
      startTime: '11:30',
      endTime: '12:30',
      seriesId: SERIES_ID,
    };

    await expect(
      service.createBatch(ATTACKER, {
        blocks: [monday, overlappingMonday] as any,
      }),
    ).rejects.toThrow('Two blocks in this request overlap on Monday');

    expect(prisma.created).toHaveLength(0);
  });

  it('runs the batch check-then-insert inside one Serializable prisma.$transaction', async () => {
    const { prisma, service } = buildService();
    const transactionSpy = jest.spyOn(prisma, '$transaction');

    await service.createBatch(ATTACKER, { blocks: [monday, wednesday] as any });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('retries the whole batch transaction on a P2034 serialization conflict, and succeeds once the retry wins', async () => {
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

    const result = await service.createBatch(ATTACKER, {
      blocks: [monday, wednesday] as any,
    });

    expect(attempts).toBe(2);
    expect(result).toHaveLength(2);
    expect(prisma.created).toHaveLength(2);
  });

  it('refuses to link any block in the batch to another user goal, and creates nothing', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.createBatch(ATTACKER, {
        blocks: [monday, { ...wednesday, goalId: VICTIM_GOAL }] as any,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.created).toHaveLength(0);
  });
});

// POST /schedule/:id/days: the Edit Block dialog's day picker. The series the
// block belongs to must end up covering exactly the requested days.
describe('ScheduleService.setSeriesDays', () => {
  const SRC = 'src-block';
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function block(id: string, dayOfWeek: number, extra: Partial<Row> = {}): Row {
    return {
      id,
      userId: ATTACKER,
      title: 'Soft Skills Lab',
      startTime: '07:00',
      endTime: '07:30',
      dayOfWeek,
      category: 'LEARNING',
      color: '#123456',
      goalId: OWN_GOAL,
      isPrivate: true,
      isRecurring: false,
      seriesId: 'series-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      ...extra,
    };
  }

  // The fake has no real transaction to roll back, so snapshot the table on
  // entry and restore it when the callback throws, the way Postgres would.
  function setup(rows: Row[]) {
    const { prisma, service } = buildService();
    prisma.scheduleBlocks = rows;
    const run = prisma.$transaction;
    prisma.$transaction = (async (fn: any, opts: any) => {
      const snapshot = [...prisma.scheduleBlocks];
      const createdBefore = prisma.created.length;
      const deletedBefore = prisma.deleted.length;
      const updatedBefore = prisma.updated.length;
      try {
        return await run(fn, opts);
      } catch (error) {
        prisma.scheduleBlocks = snapshot;
        prisma.created.length = createdBefore;
        prisma.deleted.length = deletedBefore;
        prisma.updated.length = updatedBefore;
        throw error;
      }
    }) as any;
    return { prisma, service };
  }

  const days = (blocks: Array<{ dayOfWeek: unknown }>) =>
    blocks.map((b) => b.dayOfWeek);

  it('adds days to a single block with no series: mints a seriesId on the source and the copies', async () => {
    const { prisma, service } = setup([block(SRC, 1, { seriesId: null })]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 3, 5]);

    expect(result.added).toEqual([3, 5]);
    expect(result.removed).toEqual([]);
    const minted = prisma.updated[0].data.seriesId;
    expect(minted).toMatch(UUID_RE);
    expect(prisma.updated[0].where).toEqual({ id: SRC });
    expect(prisma.created).toHaveLength(2);
    expect(prisma.created.every((b) => b.seriesId === minted)).toBe(true);
    expect(days(result.blocks)).toEqual([1, 3, 5]);
    expect(result.blocks.every((b) => b.seriesId === minted)).toBe(true);
  });

  it('copies every user-editable field and none of the per-block ones', async () => {
    const { prisma, service } = setup([block(SRC, 1)]);

    await service.setSeriesDays(ATTACKER, SRC, [1, 2]);

    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0]).toEqual({
      title: 'Soft Skills Lab',
      startTime: '07:00',
      endTime: '07:30',
      dayOfWeek: 2,
      category: 'LEARNING',
      color: '#123456',
      goalId: OWN_GOAL,
      isPrivate: true,
      isRecurring: false,
      seriesId: 'series-1',
      userId: ATTACKER,
      // Supplied by the fake in place of the database default; the service
      // sends no id, createdAt or updatedAt of its own.
      id: 'new-block-0',
    });
  });

  it('reuses the seriesId a lone block already has instead of minting another', async () => {
    const { prisma, service } = setup([block(SRC, 1, { seriesId: 'own-id' })]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 4]);

    expect(prisma.updated).toHaveLength(0);
    expect(prisma.created[0].seriesId).toBe('own-id');
    expect(days(result.blocks)).toEqual([1, 4]);
  });

  it('adds days to an existing series, only the missing ones', async () => {
    const { prisma, service } = setup([block(SRC, 1), block('wed', 3)]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 3, 5]);

    expect(result.added).toEqual([5]);
    expect(result.removed).toEqual([]);
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0].dayOfWeek).toBe(5);
    expect(days(result.blocks)).toEqual([1, 3, 5]);
  });

  it('removes days: deletes the series block on each dropped day, keeps the source', async () => {
    const { prisma, service } = setup([
      block(SRC, 1),
      block('wed', 3),
      block('fri', 5),
    ]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1]);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([3, 5]);
    expect(prisma.deleted.map((b) => b.id).sort()).toEqual(['fri', 'wed']);
    expect(result.blocks.map((b) => b.id)).toEqual([SRC]);
  });

  it('adds and removes in one call', async () => {
    const { prisma, service } = setup([block(SRC, 1), block('wed', 3)]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 4]);

    expect(result.added).toEqual([4]);
    expect(result.removed).toEqual([3]);
    expect(days(result.blocks)).toEqual([1, 4]);
    expect(prisma.deleted.map((b) => b.id)).toEqual(['wed']);
    expect(prisma.created).toHaveLength(1);
  });

  it('fails the whole request and writes nothing when one added day conflicts', async () => {
    const { prisma, service } = setup([
      block(SRC, 1),
      block('wed', 3),
      // Unrelated block already sitting in the slot on Saturday.
      block('sat-other', 6, { seriesId: 'other-series' }),
    ]);

    // Wednesday is dropped and Friday is addable, but Saturday conflicts.
    await expect(
      service.setSeriesDays(ATTACKER, SRC, [1, 5, 6]),
    ).rejects.toThrow(
      'Time slot conflicts with an existing schedule block on Saturday: "Soft Skills Lab" (Saturday 7:00 AM to 7:30 AM)',
    );

    expect(prisma.created).toHaveLength(0);
    expect(prisma.updated).toHaveLength(0);
    expect(prisma.deleted).toHaveLength(0);
    // Table is back to what it was, Wednesday's block included.
    expect(prisma.scheduleBlocks.map((b) => b.id).sort()).toEqual(
      ['sat-other', SRC, 'wed'].sort(),
    );
  });

  it('only conflicts on overlapping times: an adjacent block does not block an added day', async () => {
    const { service } = setup([
      block(SRC, 1),
      block('sat-next', 6, {
        seriesId: 'other-series',
        startTime: '07:30',
        endTime: '08:00',
      }),
    ]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 6]);

    expect(result.added).toEqual([6]);
  });

  it('deletes removed blocks before checking added slots, so a block this call removes never counts as a conflict', async () => {
    const { prisma, service } = setup([block(SRC, 1), block('wed', 3)]);
    const deletedAtConflictCheck: number[] = [];
    const realFindMany = prisma.scheduleBlock.findMany;
    prisma.scheduleBlock.findMany = (async (args: any) => {
      // The conflict check is the only findMany filtered by dayOfWeek.
      if (args.where.dayOfWeek !== undefined) {
        deletedAtConflictCheck.push(prisma.deleted.length);
      }
      return realFindMany(args);
    }) as any;

    await service.setSeriesDays(ATTACKER, SRC, [1, 4]);

    expect(deletedAtConflictCheck).toEqual([1]);
  });

  it('rejects with 400 when the source day is not in days, and writes nothing', async () => {
    const { prisma, service } = setup([block(SRC, 1), block('wed', 3)]);

    const attempt = service.setSeriesDays(ATTACKER, SRC, [3, 5]);

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(
      'Use a normal update to move a block to another day.',
    );
    expect(prisma.created).toHaveLength(0);
    expect(prisma.deleted).toHaveLength(0);
  });

  it('answers 404 for another user block and for a missing one, never leaking either', async () => {
    const { prisma, service } = setup([
      block('victim-block', 1, { userId: VICTIM, seriesId: 'victim-series' }),
    ]);

    await expect(
      service.setSeriesDays(ATTACKER, 'victim-block', [1, 2]),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.setSeriesDays(ATTACKER, 'does-not-exist', [1, 2]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.created).toHaveLength(0);
    expect(prisma.deleted).toHaveLength(0);
  });

  it('never touches another user blocks that happen to share the seriesId', async () => {
    const { prisma, service } = setup([
      block(SRC, 1),
      block('victim-fri', 5, { userId: VICTIM }),
    ]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1]);

    expect(result.removed).toEqual([]);
    expect(prisma.deleted).toHaveLength(0);
    expect(result.blocks.map((b) => b.id)).toEqual([SRC]);
  });

  it('is idempotent: the same days again change nothing', async () => {
    const { prisma, service } = setup([block(SRC, 1, { seriesId: null })]);

    await service.setSeriesDays(ATTACKER, SRC, [1, 3, 5]);
    const createdAfterFirst = prisma.created.length;
    const updatedAfterFirst = prisma.updated.length;
    const second = await service.setSeriesDays(ATTACKER, SRC, [5, 3, 1]);

    expect(second.added).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(days(second.blocks)).toEqual([1, 3, 5]);
    expect(prisma.created).toHaveLength(createdAfterFirst);
    expect(prisma.updated).toHaveLength(updatedAfterFirst);
    expect(prisma.deleted).toHaveLength(0);
  });

  it('is a no-op for a lone block asked for only its own day', async () => {
    const { prisma, service } = setup([block(SRC, 1, { seriesId: null })]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1]);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.blocks.map((b) => b.id)).toEqual([SRC]);
    expect(prisma.created).toHaveLength(0);
    expect(prisma.updated).toHaveLength(0);
  });

  it('treats a day the series already holds twice as present and never adds a third', async () => {
    const { prisma, service } = setup([
      block(SRC, 1),
      block('mon-2', 1, { startTime: '09:00', endTime: '10:00' }),
    ]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 3]);

    expect(result.added).toEqual([3]);
    expect(prisma.created.map((b) => b.dayOfWeek)).toEqual([3]);

    const again = await service.setSeriesDays(ATTACKER, SRC, [1, 3]);
    expect(again.added).toEqual([]);
    expect(prisma.created).toHaveLength(1);
  });

  it('removes every series block on a dropped day, even when it holds two', async () => {
    const { prisma, service } = setup([
      block(SRC, 1),
      block('wed-1', 3),
      block('wed-2', 3, { startTime: '09:00', endTime: '10:00' }),
    ]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1]);

    expect(result.removed).toEqual([3]);
    expect(prisma.deleted.map((b) => b.id).sort()).toEqual(['wed-1', 'wed-2']);
  });

  it('collapses duplicate days handed to the service directly', async () => {
    const { prisma, service } = setup([block(SRC, 1)]);

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 3, 3, 1]);

    expect(result.added).toEqual([3]);
    expect(prisma.created).toHaveLength(1);
  });

  it('asks for the Serializable isolation level', async () => {
    const { prisma, service } = setup([block(SRC, 1)]);
    const spy = jest.spyOn(prisma, '$transaction');

    await service.setSeriesDays(ATTACKER, SRC, [1]);

    expect(spy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('retries a P2034 serialization failure and succeeds once the retry wins', async () => {
    const { prisma, service } = setup([block(SRC, 1)]);
    const run = prisma.$transaction;
    let attempts = 0;
    prisma.$transaction = (async (fn: any, opts: any) => {
      attempts += 1;
      if (attempts === 1) {
        throw { code: 'P2034', message: 'Transaction write conflict' };
      }
      return run(fn, opts);
    }) as any;

    const result = await service.setSeriesDays(ATTACKER, SRC, [1, 2]);

    expect(attempts).toBe(2);
    expect(result.added).toEqual([2]);
    expect(prisma.created).toHaveLength(1);
  });

  it('gives up after exhausting retries on repeated P2034 failures', async () => {
    const { prisma, service } = setup([block(SRC, 1)]);
    let attempts = 0;
    prisma.$transaction = (async () => {
      attempts += 1;
      throw { code: 'P2034', message: 'Transaction write conflict' };
    }) as any;

    await expect(
      service.setSeriesDays(ATTACKER, SRC, [1, 2]),
    ).rejects.toMatchObject({ code: 'P2034' });
    expect(attempts).toBe(4);
  });

  it('applies the plan limit to the net block count, after removals', async () => {
    const { prisma, service } = setup([block(SRC, 1), block('tue', 2)]);
    prisma.scheduleBlock.count = (async () =>
      prisma.scheduleBlocks.filter((b) => b.userId === ATTACKER).length) as any;
    const limit = jest.spyOn((service as any).authService, 'checkPlanLimit');

    await service.setSeriesDays(ATTACKER, SRC, [1, 3]);

    expect(limit).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(ATTACKER, 'schedules', 1);
  });

  it('writes nothing when the plan limit refuses the added days', async () => {
    const { prisma, service } = setup([block(SRC, 1), block('tue', 2)]);
    (service as any).authService.checkPlanLimit = async () => {
      throw new ForbiddenException('plan limit');
    };

    await expect(
      service.setSeriesDays(ATTACKER, SRC, [1, 3]),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.created).toHaveLength(0);
    expect(prisma.scheduleBlocks.map((b) => b.id).sort()).toEqual([SRC, 'tue']);
  });
});
