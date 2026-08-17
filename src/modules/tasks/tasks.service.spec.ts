import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TasksService } from './tasks.service';
import { UpdateTaskDto } from './dto/tasks.dto';

// Regression cover for "a task's due date can never be removed".
//
// `update` built its data as `dueDate: dto.dueDate ? new Date(dto.dueDate) :
// undefined`, and that explicit key overrode the `...updateData` spread. So an
// explicit `null` — the only way a client can express "clear this" — collapsed
// to `undefined`, which Prisma reads as "leave unchanged". Combined with
// `UpdateTaskDto` having no null-accepting validator, there was NO payload
// shape that could unset a due date once one was set.
//
// That mattered because the Coach could attach a due date the user never
// asked for (CREATE_TASK's prompt entry did not tell the model to omit it),
// and the user then had no way to take it off short of deleting the task.

const USER = 'user-id';
const TASK = 'task-id';

class FakePrisma {
  updateCalls: any[] = [];

  task = {
    findFirst: async ({ where }: any) =>
      where.id === TASK && where.userId === USER
        ? { id: TASK, userId: USER, title: 'Call the Bank' }
        : null,
    update: async (args: any) => {
      this.updateCalls.push(args);
      return { id: TASK, ...args.data };
    },
  };
}

function makeService() {
  const prisma = new FakePrisma();
  const service = new TasksService(
    prisma as any,
    {} as any, // authService — untouched by update()
    {} as any, // goalsService — untouched by update()
  );
  return { prisma, service };
}

describe('TasksService.update dueDate', () => {
  it('clears the stored due date when given an explicit null', async () => {
    const { prisma, service } = makeService();

    await service.update(USER, TASK, { dueDate: null } as any);

    expect(prisma.updateCalls).toHaveLength(1);
    // `null`, not `undefined` — the latter is Prisma's "leave unchanged".
    expect(prisma.updateCalls[0].data.dueDate).toBeNull();
  });

  it('sets the due date when given a date string', async () => {
    const { prisma, service } = makeService();

    await service.update(USER, TASK, { dueDate: '2026-08-20' } as any);

    expect(prisma.updateCalls[0].data.dueDate).toEqual(new Date('2026-08-20'));
  });

  it('leaves the due date untouched when the key is absent', async () => {
    const { prisma, service } = makeService();

    await service.update(USER, TASK, { title: 'Renamed' } as any);

    expect(prisma.updateCalls[0].data.dueDate).toBeUndefined();
    expect('dueDate' in prisma.updateCalls[0].data).toBe(true);
  });
});

describe('UpdateTaskDto dueDate validation', () => {
  async function errorsFor(payload: Record<string, unknown>) {
    return validate(plainToInstance(UpdateTaskDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }

  it('accepts an explicit null so a client can ask to clear the date', async () => {
    expect(await errorsFor({ dueDate: null })).toHaveLength(0);
  });

  it('accepts an omitted dueDate', async () => {
    expect(await errorsFor({ title: 'Call the Bank' })).toHaveLength(0);
  });

  it('accepts a bare calendar day and a full ISO instant', async () => {
    expect(await errorsFor({ dueDate: '2026-08-20' })).toHaveLength(0);
    expect(
      await errorsFor({ dueDate: '2026-08-20T00:00:00.000Z' }),
    ).toHaveLength(0);
  });

  // Loosening the validator to allow null must not let prose through — these
  // are the shapes a model improvises when a prompt doesn't demand ISO-8601.
  it('still rejects unparseable values', async () => {
    for (const value of ['today', 'tomorrow', 'ASAP', '', '08/20/2026']) {
      expect(await errorsFor({ dueDate: value })).not.toHaveLength(0);
    }
  });
});

// Cost cover for TasksService.findAll / findOne.
//
// `trackedMinutes` used to be computed by pulling every TimeEntry row for
// every task into Node and reducing in JS:
//
//   include: { timeEntries: { select: { duration: true } } }
//
// The response never carried those rows (they were stripped with
// `timeEntries: undefined`), but the database read was O(all time entries the
// user has ever logged) and grows forever — paid on every tasks-list load, on
// both clients, at a 5-minute staleTime. It is now a single `groupBy`
// aggregate, O(tasks).
//
// These tests pin the two things that could go wrong with that swap:
//  1. the numbers must be byte-identical, including for a task with no
//     entries and for entries of every `source` (the old reducer applied no
//     source filter, so neither may the aggregate);
//  2. the per-entry rows must no longer be read at all.

const TASK_A = 'task-a';
const TASK_B = 'task-b';
const TASK_NO_ENTRIES = 'task-c';

interface TimeEntryRow {
  taskId: string | null;
  duration: number;
  source: string;
}

class FakeTrackedMinutesPrisma {
  findManyArgs: any[] = [];
  findFirstArgs: any[] = [];
  groupByArgs: any[] = [];

  private tasksById: Record<string, any> = {
    [TASK_A]: { id: TASK_A, userId: USER, title: 'A', status: 'BACKLOG' },
    [TASK_B]: { id: TASK_B, userId: USER, title: 'B', status: 'BACKLOG' },
    [TASK_NO_ENTRIES]: {
      id: TASK_NO_ENTRIES,
      userId: USER,
      title: 'C',
      status: 'BACKLOG',
    },
  };

  // Deliberately mixed `source` values. The reducer being replaced summed all
  // of them; a groupBy that quietly filtered on TRACKER would change every
  // task's displayed minutes.
  entries: TimeEntryRow[] = [
    { taskId: TASK_A, duration: 30, source: 'TRACKER' },
    { taskId: TASK_A, duration: 45, source: 'MANUAL' },
    { taskId: TASK_A, duration: 15, source: 'SCHEDULE' },
    { taskId: TASK_B, duration: 60, source: 'MANUAL' },
    { taskId: null, duration: 999, source: 'TRACKER' },
  ];

  task = {
    findMany: async (args: any) => {
      this.findManyArgs.push(args);
      // Honour `include` rather than ignoring it: a test that only asserted on
      // the recorded args would pass against a stub that silently returned
      // whatever it liked.
      const rows = Object.values(this.tasksById).map((t: any) => ({ ...t }));
      if (args?.include?.timeEntries) {
        for (const row of rows) {
          row.timeEntries = this.entries
            .filter((e) => e.taskId === row.id)
            .map((e) => ({ duration: e.duration }));
        }
      }
      return rows;
    },
    findFirst: async (args: any) => {
      this.findFirstArgs.push(args);
      const row = this.tasksById[args?.where?.id];
      if (!row || row.userId !== args?.where?.userId) return null;
      const out = { ...row };
      if (args?.include?.timeEntries) {
        out.timeEntries = this.entries
          .filter((e) => e.taskId === row.id)
          .map((e) => ({ duration: e.duration }));
      }
      return out;
    },
  };

  timeEntry = {
    groupBy: async (args: any) => {
      this.groupByArgs.push(args);
      const ids: string[] = args?.where?.taskId?.in ?? [];
      const totals = new Map<string, number>();
      for (const entry of this.entries) {
        if (entry.taskId === null) continue;
        if (!ids.includes(entry.taskId)) continue;
        totals.set(
          entry.taskId,
          (totals.get(entry.taskId) ?? 0) + entry.duration,
        );
      }
      return [...totals].map(([taskId, duration]) => ({
        taskId,
        _sum: { duration },
      }));
    },
  };
}

function buildTrackedMinutesService() {
  const prisma = new FakeTrackedMinutesPrisma();
  const service = new TasksService(prisma as any, {} as any, {} as any);
  return { prisma, service };
}

describe('TasksService trackedMinutes aggregation', () => {
  it('findAll sums every time entry for a task regardless of source', async () => {
    const { service } = buildTrackedMinutesService();

    const tasks = await service.findAll(USER, {});
    const byId = new Map(tasks.map((t: any) => [t.id, t.trackedMinutes]));

    expect(byId.get(TASK_A)).toBe(90); // 30 TRACKER + 45 MANUAL + 15 SCHEDULE
    expect(byId.get(TASK_B)).toBe(60);
  });

  it('findAll reports 0 for a task with no time entries', async () => {
    const { service } = buildTrackedMinutesService();

    const tasks = await service.findAll(USER, {});
    const taskC: any = tasks.find((t: any) => t.id === TASK_NO_ENTRIES);

    expect(taskC.trackedMinutes).toBe(0);
  });

  it('findAll no longer reads the individual time-entry rows', async () => {
    const { prisma, service } = buildTrackedMinutesService();

    await service.findAll(USER, {});

    expect(prisma.findManyArgs).toHaveLength(1);
    expect(prisma.findManyArgs[0].include).not.toHaveProperty('timeEntries');
    expect(prisma.groupByArgs).toHaveLength(1);
    expect(prisma.groupByArgs[0].by).toEqual(['taskId']);
  });

  it('findAll scopes the aggregate to the tasks it actually returned', async () => {
    const { prisma, service } = buildTrackedMinutesService();

    await service.findAll(USER, {});

    expect(prisma.groupByArgs[0].where.taskId.in.sort()).toEqual(
      [TASK_A, TASK_B, TASK_NO_ENTRIES].sort(),
    );
  });

  it('findAll does not filter the aggregate by entry source', async () => {
    const { prisma, service } = buildTrackedMinutesService();

    await service.findAll(USER, {});

    // A `source` predicate here would silently change every task's minutes.
    expect(prisma.groupByArgs[0].where).not.toHaveProperty('source');
  });

  it('findOne sums the same way and skips the per-entry read', async () => {
    const { prisma, service } = buildTrackedMinutesService();

    const task: any = await service.findOne(USER, TASK_A);

    expect(task.trackedMinutes).toBe(90);
    expect(prisma.findFirstArgs[0].include).not.toHaveProperty('timeEntries');
    expect(prisma.groupByArgs).toHaveLength(1);
  });

  it('findOne reports 0 for a task with no time entries', async () => {
    const { service } = buildTrackedMinutesService();

    const task: any = await service.findOne(USER, TASK_NO_ENTRIES);

    expect(task.trackedMinutes).toBe(0);
  });

  it('does not run an aggregate when there are no tasks to aggregate', async () => {
    const { prisma, service } = buildTrackedMinutesService();
    prisma.task.findMany = async () => [];

    const tasks = await service.findAll(USER, {});

    expect(tasks).toEqual([]);
    expect(prisma.groupByArgs).toHaveLength(0);
  });
});
