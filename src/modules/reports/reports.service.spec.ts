import { ReportsService } from './reports.service';
import { ReportFiltersDto, ExportReportDto, ExportFormat } from './dto';

// Regression cover for the perf-audit fixes below. Each report method here
// used to either (a) fetch a Prisma relation whose fields were never read
// downstream, or (b) fetch full TimeEntry rows and reduce them in JS when
// the database could do the sum/count itself via aggregate(). None of these
// change response shape — only what gets pulled off the wire per row.

function baseFilters(overrides: Partial<ReportFiltersDto> = {}) {
  return {
    startDate: '2026-08-01',
    endDate: '2026-08-07',
    ...overrides,
  } as ReportFiltersDto;
}

// ---------- getMonthlyReport: sum/count pushed into the DB ----------

class FakePrismaMonthly {
  aggregateCalls: any[] = [];
  findManyCalls: any[] = [];
  aggregateResult: any = { _sum: { duration: 0 }, _count: 0 };
  findManyRows: any[] = [];

  timeEntry = {
    aggregate: async (args: any) => {
      this.aggregateCalls.push(args);
      return this.aggregateResult;
    },
    findMany: async (args: any) => {
      this.findManyCalls.push(args);
      return this.findManyRows;
    },
  };
}

describe('ReportsService.getMonthlyReport', () => {
  function build() {
    const prisma = new FakePrismaMonthly();
    const service = new ReportsService(prisma as any);
    return { prisma, service };
  }

  it('sums duration and counts entries via aggregate() instead of reducing a full-row findMany in JS', async () => {
    const { prisma, service } = build();
    prisma.aggregateResult = { _sum: { duration: 150 }, _count: 5 };
    prisma.findManyRows = [
      { date: new Date('2026-08-01T09:00:00.000Z') },
      { date: new Date('2026-08-01T14:00:00.000Z') }, // same calendar day
      { date: new Date('2026-08-03T09:00:00.000Z') },
    ];

    const result = await service.getMonthlyReport('user_1', 2026, 8);

    expect(prisma.aggregateCalls).toHaveLength(1);
    expect(prisma.aggregateCalls[0]).toMatchObject({
      where: { userId: 'user_1' },
      _sum: { duration: true },
      _count: true,
    });

    expect(result.totalMinutes).toBe(150);
    expect(result.tasksLogged).toBe(5);
    expect(result.daysActive).toBe(2); // Aug 1 + Aug 3, dedup'd
  });

  it('selects only `date` on the remaining findMany, not full TimeEntry rows', async () => {
    const { prisma, service } = build();

    await service.getMonthlyReport('user_1', 2026, 8);

    expect(prisma.findManyCalls).toHaveLength(1);
    expect(prisma.findManyCalls[0].select).toEqual({ date: true });
    expect(prisma.findManyCalls[0].where).toMatchObject({ userId: 'user_1' });
  });
});

// ---------- getGoalProgress: Goal over-fetch trimmed ----------

class FakePrismaGoals {
  findManyCalls: any[] = [];
  rows: any[] = [];

  goal = {
    findMany: async (args: any) => {
      this.findManyCalls.push(args);
      return this.rows;
    },
  };
}

describe('ReportsService.getGoalProgress', () => {
  it('selects only the fields the response mapping reads off Goal', async () => {
    const prisma = new FakePrismaGoals();
    const service = new ReportsService(prisma as any);

    await service.getGoalProgress('user_1');

    expect(prisma.findManyCalls).toHaveLength(1);
    expect(prisma.findManyCalls[0].where).toEqual({
      userId: 'user_1',
      status: 'ACTIVE',
    });
    expect(prisma.findManyCalls[0].select).toEqual({
      id: true,
      title: true,
      color: true,
      loggedHours: true,
      targetHours: true,
      deadline: true,
    });
  });

  it('still computes progress/status correctly off the trimmed row shape', async () => {
    const prisma = new FakePrismaGoals();
    const service = new ReportsService(prisma as any);
    prisma.rows = [
      {
        id: 'g1',
        title: 'Learn Rust',
        color: '#111',
        loggedHours: 5,
        targetHours: 10,
        deadline: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      },
    ];

    const [progress] = await service.getGoalProgress('user_1');

    expect(progress.progress).toBe(50);
    expect(progress.status).toBe('in-progress');
  });
});

// ---------- getSummaryReport: unused task.notes dropped ----------

class FakePrismaTimeEntry {
  findManyCalls: any[] = [];
  rows: any[] = [];

  timeEntry = {
    findMany: async (args: any) => {
      this.findManyCalls.push(args);
      return this.rows;
    },
  };
}

describe('ReportsService.getSummaryReport', () => {
  it('does not select task.notes — aggregateByGroup() never reads it', async () => {
    const prisma = new FakePrismaTimeEntry();
    const service = new ReportsService(prisma as any);
    prisma.rows = [
      {
        id: 'e1',
        goalId: 'g1',
        taskId: 't1',
        taskName: 'Write code',
        date: new Date('2026-08-01'),
        duration: 30,
        goal: { id: 'g1', title: 'Goal 1', color: '#fff', category: 'WORK' },
        task: { id: 't1', title: 'Write code', category: 'WORK' },
      },
    ];

    const result = await service.getSummaryReport('user_1', baseFilters());

    expect(prisma.findManyCalls).toHaveLength(1);
    expect(prisma.findManyCalls[0].include.task.select).toEqual({
      id: true,
      title: true,
      category: true,
    });
    expect(result.summary.totalMinutes).toBe(30);
    expect(result.items[0].totalMinutes).toBe(30);
  });
});

// ---------- getDayByTaskReport: dead `task` include removed ----------

describe('ReportsService.getDayByTaskReport', () => {
  it('does not join the Task relation at all — the report only ever reads the entry taskName snapshot', async () => {
    const prisma = new FakePrismaTimeEntry();
    const service = new ReportsService(prisma as any);
    prisma.rows = [
      {
        id: 'e1',
        goalId: 'g1',
        taskId: 't1',
        taskName: 'Write code',
        date: new Date('2026-08-01'),
        dayOfWeek: 6,
        duration: 30,
        goal: { id: 'g1', title: 'Goal 1', color: '#fff' },
      },
    ];

    const result = await service.getDayByTaskReport('user_1', baseFilters());

    expect(prisma.findManyCalls).toHaveLength(1);
    expect(prisma.findManyCalls[0].include).toEqual({
      goal: { select: { id: true, title: true, color: true } },
    });
    expect(result.dailyBreakdown[0].tasks[0].taskName).toBe('Write code');
  });
});

// ---------- getDayTotalReport: dead `scheduleBlock` include removed, task trimmed ----------

describe('ReportsService.getDayTotalReport', () => {
  it('drops the unused scheduleBlock join and trims task to just `title`', async () => {
    const prisma = new FakePrismaTimeEntry();
    const service = new ReportsService(prisma as any);
    prisma.rows = [
      {
        id: 'e1',
        goalId: 'g1',
        taskId: 't1',
        taskName: 'Write code',
        date: new Date('2026-08-01'),
        dayOfWeek: 6,
        duration: 30,
        goal: { id: 'g1', title: 'Goal 1', color: '#fff' },
        task: { title: 'Write code (linked)' },
      },
    ];

    const result = await service.getDayTotalReport('user_1', baseFilters());

    expect(prisma.findManyCalls).toHaveLength(1);
    expect(prisma.findManyCalls[0].include).toEqual({
      task: { select: { title: true } },
      goal: { select: { id: true, title: true, color: true } },
    });
    // task.title still wins over the taskName snapshot when present, proving
    // the trimmed select still carries the field this report actually uses.
    expect(result.dailyBreakdown[0].taskNames).toBe('Write code (linked)');
  });
});

// ---------- getScheduleReport: task/scheduleBlock includes trimmed ----------

class FakePrismaSchedule {
  scheduleBlockFindManyCalls: any[] = [];
  timeEntryFindManyCalls: any[] = [];
  blocks: any[] = [];
  entries: any[] = [];

  scheduleBlock = {
    findMany: async (args: any) => {
      this.scheduleBlockFindManyCalls.push(args);
      return this.blocks;
    },
  };

  timeEntry = {
    findMany: async (args: any) => {
      this.timeEntryFindManyCalls.push(args);
      return this.entries;
    },
  };
}

describe('ReportsService.getScheduleReport', () => {
  it('trims the entries query to the fields the pattern-matching loop reads', async () => {
    const prisma = new FakePrismaSchedule();
    const service = new ReportsService(prisma as any);
    prisma.blocks = [
      {
        id: 'block_1',
        title: 'Deep Work',
        startTime: '09:00',
        endTime: '10:00',
        dayOfWeek: 6,
        category: 'WORK',
        color: '#123',
        goal: null,
      },
    ];
    prisma.entries = [
      {
        id: 'e1',
        date: new Date('2026-08-01'),
        duration: 45,
        taskName: 'Deep work session',
        scheduleBlockId: 'block_1',
        scheduleBlock: {
          title: 'Deep Work',
          startTime: '09:00',
          endTime: '10:00',
        },
        task: null,
      },
    ];

    const result = await service.getScheduleReport('user_1', baseFilters());

    expect(prisma.timeEntryFindManyCalls).toHaveLength(1);
    expect(prisma.timeEntryFindManyCalls[0].include).toEqual({
      task: { select: { title: true } },
      scheduleBlock: {
        select: { title: true, startTime: true, endTime: true },
      },
    });

    // Functional sanity: the trimmed fields are still enough to match the
    // entry back to its schedule pattern and log the minutes against it.
    expect(result.summary.totalMinutes).toBe(45);
    expect(result.rows[0].totalLogged).toBe(45);
  });
});

// ---------- source filter: COMPLETION-sourced entries excluded by default ----------
//
// TasksService.complete writes a TimeEntry tagged `source: COMPLETION` purely
// to credit Goal.loggedHours when a task is finished without a manual timer.
// Reports should default to excluding those so they only show real tracked
// time, while still letting a caller opt back in via `sources`.

describe('ReportsService source filtering', () => {
  const reportMethods: Array<{
    name: string;
    call: (
      service: ReportsService,
      prisma: FakePrismaTimeEntry | FakePrismaSchedule,
      filters: ReportFiltersDto,
    ) => Promise<unknown>;
  }> = [
    {
      name: 'getDetailedReport',
      call: (service, _prisma, filters) =>
        service.getDetailedReport('user_1', filters),
    },
    {
      name: 'getSummaryReport',
      call: (service, _prisma, filters) =>
        service.getSummaryReport('user_1', filters),
    },
    {
      name: 'getDayByTaskReport',
      call: (service, _prisma, filters) =>
        service.getDayByTaskReport('user_1', filters),
    },
    {
      name: 'getDayTotalReport',
      call: (service, _prisma, filters) =>
        service.getDayTotalReport('user_1', filters),
    },
  ];

  it.each(reportMethods)(
    '$name excludes COMPLETION-sourced entries by default when no `sources` filter is passed',
    async ({ call }) => {
      const prisma = new FakePrismaTimeEntry();
      const service = new ReportsService(prisma as any);

      await call(service, prisma, baseFilters());

      expect(prisma.findManyCalls).toHaveLength(1);
      expect(prisma.findManyCalls[0].where.source).toEqual({
        not: 'COMPLETION',
      });
    },
  );

  it.each(reportMethods)(
    '$name lets a caller opt back into COMPLETION entries via an explicit `sources` include-list',
    async ({ call }) => {
      const prisma = new FakePrismaTimeEntry();
      const service = new ReportsService(prisma as any);

      await call(
        service,
        prisma,
        baseFilters({ sources: 'TRACKER,COMPLETION' }),
      );

      expect(prisma.findManyCalls[0].where.source).toEqual({
        in: ['TRACKER', 'COMPLETION'],
      });
    },
  );

  it.each(reportMethods)(
    '$name honors a `sources` filter that requests only TRACKER (still excluding COMPLETION)',
    async ({ call }) => {
      const prisma = new FakePrismaTimeEntry();
      const service = new ReportsService(prisma as any);

      await call(service, prisma, baseFilters({ sources: 'TRACKER' }));

      expect(prisma.findManyCalls[0].where.source).toEqual({ in: ['TRACKER'] });
    },
  );

  it('ignores garbage values in `sources` and falls back to the default COMPLETION-exclusion', async () => {
    const prisma = new FakePrismaTimeEntry();
    const service = new ReportsService(prisma as any);

    await service.getDetailedReport(
      'user_1',
      baseFilters({ sources: 'not-a-real-source' }),
    );

    expect(prisma.findManyCalls[0].where.source).toEqual({
      not: 'COMPLETION',
    });
  });

  it('getScheduleReport also excludes COMPLETION-sourced entries by default', async () => {
    const prisma = new FakePrismaSchedule();
    const service = new ReportsService(prisma as any);

    await service.getScheduleReport('user_1', baseFilters());

    expect(prisma.timeEntryFindManyCalls).toHaveLength(1);
    expect(prisma.timeEntryFindManyCalls[0].where.source).toEqual({
      not: 'COMPLETION',
    });
  });

  it('getScheduleReport honors an explicit `sources` include-list requesting COMPLETION', async () => {
    const prisma = new FakePrismaSchedule();
    const service = new ReportsService(prisma as any);

    await service.getScheduleReport(
      'user_1',
      baseFilters({ sources: 'COMPLETION' }),
    );

    expect(prisma.timeEntryFindManyCalls[0].where.source).toEqual({
      in: ['COMPLETION'],
    });
  });
});

// ---------- excludeEntryIds: export-only filter that hides entries without deleting them ----------

class FakePrismaExport {
  findManyCalls: any[] = [];
  rows: any[] = [];

  user = {
    findUnique: async () => ({ name: 'Test User', email: 'test@example.com' }),
  };

  timeEntry = {
    findMany: async (args: any) => {
      this.findManyCalls.push(args);
      return this.rows;
    },
  };
}

function baseExportFilters(
  overrides: Partial<ExportReportDto> = {},
): ExportReportDto {
  return {
    startDate: '2026-08-01',
    endDate: '2026-08-07',
    format: ExportFormat.JSON,
    ...overrides,
  } as ExportReportDto;
}

describe('ReportsService.generateExport excludeEntryIds', () => {
  it('filters excludeEntryIds out of the TimeEntry query (id notIn) rather than deleting anything', async () => {
    const prisma = new FakePrismaExport();
    const service = new ReportsService(prisma as any);
    prisma.rows = [
      {
        id: 'e2',
        goalId: null,
        taskId: null,
        taskName: 'Kept entry',
        date: new Date('2026-08-01'),
        duration: 20,
        goal: null,
        task: null,
      },
    ];

    await service.generateExport(
      'user_1',
      baseExportFilters({ excludeEntryIds: ['e1', 'e3'] }),
    );

    expect(prisma.findManyCalls).toHaveLength(1);
    expect(prisma.findManyCalls[0].where.id).toEqual({ notIn: ['e1', 'e3'] });
  });

  it('omits the id filter entirely when excludeEntryIds is not provided', async () => {
    const prisma = new FakePrismaExport();
    const service = new ReportsService(prisma as any);

    await service.generateExport('user_1', baseExportFilters());

    expect(prisma.findManyCalls[0].where.id).toBeUndefined();
  });

  it('plain (non-export) report calls never populate excludeEntryIds, so the id filter is absent', async () => {
    const prisma = new FakePrismaTimeEntry();
    const service = new ReportsService(prisma as any);

    await service.getDetailedReport('user_1', baseFilters());

    expect(prisma.findManyCalls[0].where.id).toBeUndefined();
  });
});
