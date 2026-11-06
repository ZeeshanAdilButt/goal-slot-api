import { CoachAiService } from '../../coach-ai/coach-ai.service';
import { ReportsService } from '../../reports/reports.service';
import { CategoriesService } from '../../categories/categories.service';
import { TemplatesService } from '../../templates/templates.service';
import { ADMIN, MEMBER, MEMBER2, buildWorld } from './world';

// Non-negotiable from the spec: nobody ever sees another user's personal
// tasks, goals, schedule or time entries through a project. Reports, the
// coach, templates and categories read by userId; sharing a project with
// someone must not make any of them start returning that person's tasks or
// time. Each test seeds MEMBER2 (and ADMIN) with project tasks and time on
// them in the project MEMBER belongs to, then reads as MEMBER.

const recent = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

function worldWithForeignTime() {
  const w = buildWorld();
  // Time on the SHARED project task, logged by three different people.
  w.db.seed('timeEntry', {
    id: 'te-member',
    userId: MEMBER,
    taskId: 't-member2-project',
    taskName: 'MEMBER own minutes',
    duration: 15,
    date: recent(),
    source: 'MANUAL',
  });
  w.db.seed('timeEntry', {
    id: 'te-member2',
    userId: MEMBER2,
    taskId: 't-member2-project',
    taskName: 'MEMBER2 secret minutes',
    duration: 40,
    date: recent(),
    source: 'MANUAL',
  });
  w.db.seed('timeEntry', {
    id: 'te-admin',
    userId: ADMIN,
    taskId: 't-admin-project',
    goalId: 'g-admin',
    taskName: 'ADMIN secret minutes',
    duration: 60,
    date: recent(),
    source: 'MANUAL',
  });
  w.db.tables.goal.find((g) => g.id === 'g-admin')!.status = 'ACTIVE';
  w.db.tables.goal.find((g) => g.id === 'g-member')!.status = 'ACTIVE';
  return w;
}

describe('no leaks through projects', () => {
  describe('coach context', () => {
    it("never includes another member's time entries, goals or schedule", async () => {
      const w = worldWithForeignTime();
      const coach = new CoachAiService(w.prisma, {} as any, {} as any);

      const ctx = await (coach as any).buildContextBundle(MEMBER, '2026-W45', {
        includeNoteTitles: true,
      });

      expect(ctx.recentTimeEntries.map((e: any) => e.id)).toEqual([
        'te-member',
      ]);
      expect(ctx.activeGoals.map((g: any) => g.id)).toEqual(['g-member']);
      expect(ctx.scheduleBlocks).toEqual([]);

      const serialized = JSON.stringify(ctx);
      for (const secret of [
        'MEMBER2 secret minutes',
        'ADMIN secret minutes',
        'Admin private goal',
        'Admin focus',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    });
  });

  describe('reports', () => {
    it("the task filter list has only tasks I created, not teammates' project tasks", async () => {
      const w = worldWithForeignTime();
      const reports = new ReportsService(w.prisma);

      const tasks = await reports.getFilterableTasks(MEMBER);

      expect(tasks.map((t: any) => t.id).sort()).toEqual(
        ['t-member-personal', 't-member-project'].sort(),
      );
    });

    it('the day-by-task report only counts my own minutes on a shared task', async () => {
      const w = worldWithForeignTime();
      const reports = new ReportsService(w.prisma);
      const day = recent().toISOString().slice(0, 10);

      const report = await reports.getDayByTaskReport(MEMBER, {
        startDate: day,
        endDate: day,
      } as any);

      const serialized = JSON.stringify(report);
      expect(serialized).toContain('MEMBER own minutes');
      expect(serialized).not.toContain('MEMBER2 secret minutes');
      expect(serialized).not.toContain('ADMIN secret minutes');
    });

    it('every task and time-entry read a report makes is scoped to the requester', async () => {
      const w = worldWithForeignTime();
      const reports = new ReportsService(w.prisma);
      const day = recent().toISOString().slice(0, 10);

      await reports.getFilterableTasks(MEMBER);
      await reports.getDayByTaskReport(MEMBER, {
        startDate: day,
        endDate: day,
      } as any);

      const reads = w.db.calls.filter((c) =>
        ['task', 'timeEntry'].includes(c.model),
      );
      expect(reads.length).toBeGreaterThan(0);
      for (const call of reads) expect(call.args.where.userId).toBe(MEMBER);
    });
  });

  describe('categories', () => {
    it("deleting my category leaves teammates' project tasks with the same category alone", async () => {
      const w = buildWorld();
      const categories = new CategoriesService(w.prisma);
      const cat = w.db.seed('category', {
        userId: MEMBER,
        name: 'Deep',
        value: 'DEEP',
      });
      w.db.tables.task.find((t) => t.id === 't-member-personal')!.category =
        'DEEP';
      w.db.tables.task.find((t) => t.id === 't-member2-project')!.category =
        'DEEP';

      const result = await categories.delete(MEMBER, cat.id);

      expect(result.usageCount).toBe(1);
      expect(
        w.db.tables.task.find((t) => t.id === 't-member-personal')!.category,
      ).toBeNull();
      expect(
        w.db.tables.task.find((t) => t.id === 't-member2-project')!.category,
      ).toBe('DEEP');
    });
  });

  describe('templates', () => {
    it("syncing a template dedupes against my tasks only, not a teammate's", async () => {
      const w = buildWorld();
      const templates = new TemplatesService(w.prisma);
      const summary = templates
        .list()
        .map((t) => templates.getOne(t.id))
        .find(
          (t) =>
            (t.tasks ?? []).some((task) => task.goalRef) &&
            (t.goals ?? []).length > 0,
        )!;
      expect(summary).toBeDefined();

      for (const g of summary.goals ?? []) {
        w.db.seed('goal', {
          userId: MEMBER,
          title: g.title,
          templateId: summary.id,
          templateGoalRef: g.ref,
        });
      }
      // MEMBER2 already has every template task, inside the shared project.
      for (const t of summary.tasks ?? []) {
        w.db.seed('task', {
          userId: MEMBER2,
          projectId: 'p-1',
          title: t.title,
          templateId: summary.id,
          templateTaskKey: (templates as any).taskKey(t),
        });
      }

      const result = await templates.syncTasks(MEMBER, summary.id);

      expect(result.tasksAdded).toBeGreaterThan(0);
      const added = w.db.tables.task.filter(
        (t) => t.userId === MEMBER && t.templateId === summary.id,
      );
      expect(added).toHaveLength(result.tasksAdded);
      expect(added.every((t) => t.projectId === null)).toBe(true);
    });
  });

  describe('My tasks', () => {
    it("never includes a teammate's personal tasks or their unassigned project tasks", async () => {
      const w = buildWorld();
      const mine = await w.tasksService.findAll(MEMBER, {});
      const owners = new Set(
        mine.map((t: any) => `${t.userId}:${t.assigneeId}`),
      );
      for (const t of mine) {
        const visible = t.userId === MEMBER || t.assigneeId === MEMBER;
        expect(visible).toBe(true);
      }
      expect(owners.size).toBeGreaterThan(0);
      expect(mine.map((t: any) => t.id)).not.toContain('t-admin-personal');
      expect(mine.map((t: any) => t.id)).not.toContain('t-admin-project');
    });
  });
});
