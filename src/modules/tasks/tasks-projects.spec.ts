import {
  ADMIN,
  GUEST,
  MEMBER,
  MEMBER2,
  OUTSIDER,
  buildWorld,
  outcome,
} from '../projects/__tests__/world';

// Projects inside Tasks, from the TasksService side: list scopes, the goal
// rule, assignment, moving between projects, and complete/restore on a
// project task. The world (see world.ts) has project p-1 with ADMIN,
// MEMBER, MEMBER2 and GUEST, and these project tasks:
//   t-admin-project    created by ADMIN, unassigned, linked to ADMIN's goal + block
//   t-member-project   created by MEMBER, unassigned
//   t-member2-project  created by MEMBER2, assigned to MEMBER
// plus one personal task each for ADMIN, MEMBER and OUTSIDER.

const P = 'p-1';
const ids = (tasks: Array<{ id: string }>) => tasks.map((t) => t.id).sort();

describe('TasksService with projects', () => {
  describe('GET /tasks scopes', () => {
    it('defaults to scope=mine: personal, assigned to me, and mine-and-unassigned', async () => {
      const w = buildWorld();
      const tasks = await w.tasksService.findAll(MEMBER, {});
      expect(ids(tasks)).toEqual(
        ['t-member-personal', 't-member-project', 't-member2-project'].sort(),
      );
    });

    it('scope=mine leaves out a task I created once someone else is assigned', async () => {
      const w = buildWorld();
      await w.tasksService.update(MEMBER, 't-member-project', {
        assigneeId: MEMBER2,
      });
      const tasks = await w.tasksService.findAll(MEMBER, { scope: 'mine' });
      expect(ids(tasks)).not.toContain('t-member-project');
      expect(ids(await w.tasksService.findAll(MEMBER2, {}))).toContain(
        't-member-project',
      );
    });

    it('scope=personal is only my personal tasks', async () => {
      const w = buildWorld();
      const tasks = await w.tasksService.findAll(MEMBER, { scope: 'personal' });
      expect(ids(tasks)).toEqual(['t-member-personal']);
    });

    it('projectId lists every task in the project, for any member', async () => {
      const w = buildWorld();
      const all = [
        't-admin-project',
        't-member-project',
        't-member2-project',
      ].sort();
      for (const actor of [ADMIN, MEMBER, GUEST]) {
        expect(
          ids(await w.tasksService.findAll(actor, { projectId: P })),
        ).toEqual(all);
      }
    });

    it('projectId with assignee=me | unassigned | <userId>', async () => {
      const w = buildWorld();
      expect(
        ids(
          await w.tasksService.findAll(MEMBER, {
            projectId: P,
            assignee: 'me',
          }),
        ),
      ).toEqual(['t-member2-project']);
      expect(
        ids(
          await w.tasksService.findAll(GUEST, {
            projectId: P,
            assignee: 'unassigned',
          }),
        ),
      ).toEqual(['t-admin-project', 't-member-project']);
      expect(
        ids(
          await w.tasksService.findAll(GUEST, {
            projectId: P,
            assignee: MEMBER,
          }),
        ),
      ).toEqual(['t-member2-project']);
    });

    it('assignee without projectId is a 400', async () => {
      const w = buildWorld();
      expect(
        await outcome(() => w.tasksService.findAll(MEMBER, { assignee: 'me' })),
      ).toBe(400);
    });

    it('existing status filters still apply inside a project', async () => {
      const w = buildWorld();
      const doing = await w.tasksService.findAll(GUEST, {
        projectId: P,
        statuses: ['DOING' as any],
      });
      expect(ids(doing)).toEqual(['t-member2-project']);
    });

    it('an archived project drops out of My tasks but its board still loads', async () => {
      const w = buildWorld();
      await w.projects.update(ADMIN, P, { archived: true });
      expect(ids(await w.tasksService.findAll(MEMBER, {}))).toEqual([
        't-member-personal',
      ]);
      expect(
        await w.tasksService.findAll(MEMBER, { projectId: P }),
      ).toHaveLength(3);
    });

    it('for someone with no projects, mine is exactly their personal tasks in the old shape', async () => {
      const w = buildWorld();
      const tasks = await w.tasksService.findAll(OUTSIDER, {});
      expect(ids(tasks)).toEqual(['t-outsider-personal']);
      const [t] = tasks;
      expect(t).toMatchObject({
        id: 't-outsider-personal',
        userId: OUTSIDER,
        project: null,
        assignee: null,
        canEdit: true,
        trackedMinutes: 0,
      });
    });
  });

  describe('the goal rule', () => {
    it('shows goal and schedule block to their owner only', async () => {
      const w = buildWorld();

      const asAdmin = await w.tasksService.findOne(ADMIN, 't-admin-project');
      expect(asAdmin.goal).toMatchObject({
        id: 'g-admin',
        title: 'Admin private goal',
      });
      expect(asAdmin.scheduleBlock).toMatchObject({ id: 'sb-admin' });

      for (const actor of [MEMBER, GUEST]) {
        const t = await w.tasksService.findOne(actor, 't-admin-project');
        expect(t.goal).toBeNull();
        expect(t.goalId).toBeNull();
        expect(t.scheduleBlock).toBeNull();
        expect(t.scheduleBlockId).toBeNull();
      }

      const board = await w.tasksService.findAll(MEMBER, { projectId: P });
      const leaked = JSON.stringify(board);
      expect(leaked).not.toContain('Admin private goal');
      expect(leaked).not.toContain('Admin focus');
    });

    it('a goalId filter on a project only matches goals the requester owns', async () => {
      const w = buildWorld();
      expect(
        await w.tasksService.findAll(MEMBER, {
          projectId: P,
          goalId: 'g-admin',
        }),
      ).toEqual([]);
      expect(
        ids(
          await w.tasksService.findAll(ADMIN, {
            projectId: P,
            goalId: 'g-admin',
          }),
        ),
      ).toEqual(['t-admin-project']);
    });

    it("another member's edit cannot clear or repoint the creator's goal", async () => {
      const w = buildWorld();
      await w.tasksService.update(MEMBER, 't-admin-project', {
        title: 'Renamed by member',
        goalId: null as any,
        scheduleBlockId: 'sb-somewhere-else',
      });
      const row = w.db.tables.task.find((t) => t.id === 't-admin-project')!;
      expect(row.title).toBe('Renamed by member');
      expect(row.goalId).toBe('g-admin');
      expect(row.scheduleBlockId).toBe('sb-admin');
    });

    it('the creator can only link their own goal, as before', async () => {
      const w = buildWorld();
      expect(
        await outcome(() =>
          w.tasksService.update(MEMBER, 't-member-project', {
            goalId: 'g-admin',
          }),
        ),
      ).toBe(403);
      expect(
        await outcome(() =>
          w.tasksService.update(MEMBER, 't-member-project', {
            goalId: 'g-member',
          }),
        ),
      ).toBe('ok');
    });
  });

  describe('responses', () => {
    it('carry project, assignee and canEdit', async () => {
      const w = buildWorld();
      const asMember = await w.tasksService.findOne(
        MEMBER,
        't-member2-project',
      );
      // userId is the creator; the web hides Delete for MEMBERs on others' tasks.
      expect(asMember.userId).toBe(MEMBER2);
      expect(asMember.project).toEqual({
        id: P,
        name: 'Launch',
        color: '#16A34A',
      });
      expect(asMember.assignee).toEqual({
        id: MEMBER,
        name: 'Mo Member',
        avatar: null,
      });
      expect(asMember.canEdit).toBe(true);

      const asGuest = await w.tasksService.findOne(GUEST, 't-member2-project');
      expect(asGuest.canEdit).toBe(false);
    });
  });

  describe('create and assign', () => {
    it('creates a project task with a member assignee', async () => {
      const w = buildWorld();
      const t = await w.tasksService.create(MEMBER, {
        title: 'Write copy',
        projectId: P,
        assigneeId: MEMBER2,
      });
      expect(t).toMatchObject({
        userId: MEMBER,
        projectId: P,
        assigneeId: MEMBER2,
        project: { id: P },
        assignee: { id: MEMBER2 },
        canEdit: true,
      });
    });

    it('rejects an assignee who is not a member, and an assignee without a project', async () => {
      const w = buildWorld();
      expect(
        await outcome(() =>
          w.tasksService.create(MEMBER, {
            title: 'x',
            projectId: P,
            assigneeId: OUTSIDER,
          }),
        ),
      ).toBe(400);
      expect(
        await outcome(() =>
          w.tasksService.create(MEMBER, { title: 'x', assigneeId: MEMBER2 }),
        ),
      ).toBe(400);
      expect(
        await outcome(() =>
          w.tasksService.update(MEMBER, 't-member-project', {
            assigneeId: OUTSIDER,
          }),
        ),
      ).toBe(400);
    });

    it('a guest can be assigned (assignee only has to be a member)', async () => {
      const w = buildWorld();
      expect(
        await outcome(() =>
          w.tasksService.update(ADMIN, 't-admin-project', {
            assigneeId: GUEST,
          }),
        ),
      ).toBe('ok');
    });

    it('null unassigns', async () => {
      const w = buildWorld();
      await w.tasksService.update(ADMIN, 't-member2-project', {
        assigneeId: null,
      });
      expect(
        w.db.tables.task.find((t) => t.id === 't-member2-project')!.assigneeId,
      ).toBeNull();
    });

    it('a plain personal edit writes no project or assignee keys', async () => {
      const w = buildWorld();
      await w.tasksService.update(MEMBER, 't-member-personal', {
        title: 'Renamed',
      });
      const call = w.db.calls
        .filter((c) => c.model === 'task' && c.op === 'update')
        .at(-1)!;
      expect(call.args.data).not.toHaveProperty('projectId');
      expect(call.args.data).not.toHaveProperty('assigneeId');
    });
  });

  describe('moving between personal and a project', () => {
    it('the creator can move a personal task into a project they can write to, and back', async () => {
      const w = buildWorld();
      await w.tasksService.update(MEMBER, 't-member-personal', {
        projectId: P,
      });
      expect(
        ids(await w.tasksService.findAll(ADMIN, { projectId: P })),
      ).toContain('t-member-personal');

      await w.tasksService.update(MEMBER, 't-member-personal', {
        projectId: null,
      });
      expect(
        ids(await w.tasksService.findAll(ADMIN, { projectId: P })),
      ).not.toContain('t-member-personal');
    });

    it('moving back to personal clears the assignee', async () => {
      const w = buildWorld();
      await w.tasksService.update(MEMBER2, 't-member2-project', {
        projectId: null,
      });
      const row = w.db.tables.task.find((t) => t.id === 't-member2-project')!;
      expect(row.projectId).toBeNull();
      expect(row.assigneeId).toBeNull();
    });

    it('moving to a project the assignee is not in clears the assignee', async () => {
      const w = buildWorld();
      w.db.seed('project', { id: 'p-2', name: 'Two', createdById: MEMBER2 });
      w.db.seed('projectMember', {
        projectId: 'p-2',
        userId: MEMBER2,
        role: 'ADMIN',
      });

      await w.tasksService.update(MEMBER2, 't-member2-project', {
        projectId: 'p-2',
      });
      const row = w.db.tables.task.find((t) => t.id === 't-member2-project')!;
      expect(row.projectId).toBe('p-2');
      expect(row.assigneeId).toBeNull();
    });

    it('only the creator can move a task, and only into a project they can write to', async () => {
      const w = buildWorld();
      expect(
        await outcome(() =>
          w.tasksService.update(ADMIN, 't-member-project', { projectId: null }),
        ),
      ).toBe(403);

      w.db.seed('project', {
        id: 'p-guest',
        name: 'Read only',
        createdById: OUTSIDER,
      });
      w.db.seed('projectMember', {
        projectId: 'p-guest',
        userId: MEMBER,
        role: 'GUEST',
      });
      expect(
        await outcome(() =>
          w.tasksService.update(MEMBER, 't-member-personal', {
            projectId: 'p-guest',
          }),
        ),
      ).toBe(403);
      expect(
        await outcome(() =>
          w.tasksService.update(MEMBER, 't-member-personal', {
            projectId: 'p-nowhere',
          }),
        ),
      ).toBe(404);
    });
  });

  describe('complete and restore on a project task', () => {
    it("a member completing the creator's task logs their own time and leaves the creator's goal alone", async () => {
      const w = buildWorld();
      const result = await w.tasksService.complete(MEMBER, 't-admin-project', {
        actualMinutes: 45,
      });

      expect(result.timeEntry).toMatchObject({
        userId: MEMBER,
        taskId: 't-admin-project',
        goalId: null,
        scheduleBlockId: null,
        duration: 45,
      });
      expect(result.task.goal).toBeNull();
      expect(w.goals.progressCalls).toEqual([]);
    });

    it('the goal owner completing it still updates their goal', async () => {
      const w = buildWorld();
      const result = await w.tasksService.complete(ADMIN, 't-admin-project', {
        actualMinutes: 45,
      });
      expect(result.timeEntry).toMatchObject({
        userId: ADMIN,
        goalId: 'g-admin',
        scheduleBlockId: 'sb-admin',
      });
      expect(w.goals.progressCalls).toEqual([
        { goalId: 'g-admin', userId: ADMIN },
      ]);
    });

    it("restoring does not delete another member's completion entry", async () => {
      const w = buildWorld();
      await w.tasksService.complete(ADMIN, 't-admin-project', {
        actualMinutes: 45,
      });
      await w.tasksService.restore(MEMBER, 't-admin-project');

      const row = w.db.tables.task.find((t) => t.id === 't-admin-project')!;
      expect(row.status).toBe('TODO');
      expect(
        w.db.tables.timeEntry.filter((e) => e.userId === ADMIN),
      ).toHaveLength(1);
    });

    it('restoring your own completion removes your entry, as before', async () => {
      const w = buildWorld();
      await w.tasksService.complete(MEMBER, 't-member-personal', {
        actualMinutes: 20,
      });
      await w.tasksService.restore(MEMBER, 't-member-personal');
      expect(
        w.db.tables.timeEntry.filter((e) => e.userId === MEMBER),
      ).toHaveLength(0);
    });
  });

  describe('reorder', () => {
    it('a project reorder only touches tasks in that project', async () => {
      const w = buildWorld();
      await w.tasksService.reorder(
        MEMBER,
        ['t-member2-project', 't-admin-project', 't-outsider-personal'],
        P,
      );
      const order = (id: string) =>
        w.db.tables.task.find((t) => t.id === id)!.order;
      expect(order('t-member2-project')).toBe(0);
      expect(order('t-admin-project')).toBe(1);
      expect(order('t-outsider-personal')).toBe(0); // untouched default
      const writes = w.db.calls.filter(
        (c) => c.model === 'task' && c.op === 'updateMany',
      );
      expect(writes.every((c) => c.args.where.projectId === P)).toBe(true);
    });

    it('without projectId, reorders every id the caller can write and skips the rest', async () => {
      const w = buildWorld();
      await w.tasksService.reorder(MEMBER, [
        't-outsider-personal', // someone else's personal task: skipped
        't-admin-project', // project task, MEMBER can write: reordered
        't-member-personal', // my own personal task: reordered
      ]);
      const order = (id: string) =>
        w.db.tables.task.find((t) => t.id === id)!.order;
      expect(order('t-admin-project')).toBe(1);
      expect(order('t-member-personal')).toBe(2);
      expect(order('t-outsider-personal')).toBe(0); // default, not written
    });

    it('without projectId, a guest cannot reorder project tasks', async () => {
      const w = buildWorld();
      w.db.tables.task.find((t) => t.id === 't-admin-project')!.order = 7;
      await w.tasksService.reorder(GUEST, [
        't-member2-project',
        't-admin-project',
      ]);
      expect(
        w.db.tables.task.find((t) => t.id === 't-admin-project')!.order,
      ).toBe(7);
      expect(
        w.db.tables.task.find((t) => t.id === 't-member2-project')!.order,
      ).toBe(0);
    });

    it('a removed member can no longer reorder tasks they created in the project', async () => {
      const w = buildWorld();
      await w.projects.removeMember(ADMIN, P, MEMBER);
      await w.tasksService.reorder(MEMBER, [
        't-member2-project',
        't-member-project',
      ]);
      expect(
        w.db.tables.task.find((t) => t.id === 't-member-project')!.order,
      ).toBe(0);
    });
  });
});
