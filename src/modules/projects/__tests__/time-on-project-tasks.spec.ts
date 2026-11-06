import { ADMIN, GUEST, MEMBER, OUTSIDER, buildWorld, outcome } from './world';

// Time entries and the active timer used to accept a task only when the
// caller created it. A project member must now be able to log time and run
// the timer on another member's project task, while guests and outsiders
// are refused exactly as a stranger's task always was. Goal and schedule
// block stay strictly the caller's own.

const OTHERS_TASK = 't-member2-project'; // created by MEMBER2
const entry = (taskId: string, extra: Record<string, unknown> = {}) => ({
  taskName: 'Work',
  duration: 30,
  date: '2026-11-06',
  taskId,
  ...extra,
});

describe('time entries on project tasks', () => {
  it("a member logs time on another member's project task, with the title snapshotted", async () => {
    const w = buildWorld();
    const created: any = await w.timeEntries.create(
      MEMBER,
      entry(OTHERS_TASK) as any,
    );

    expect(created).toMatchObject({
      userId: MEMBER,
      taskId: OTHERS_TASK,
      taskTitle: 'Member2 project task',
    });
  });

  it('an ADMIN can log time on any task in the project', async () => {
    const w = buildWorld();
    expect(
      await outcome(() =>
        w.timeEntries.create(ADMIN, entry(OTHERS_TASK) as any),
      ),
    ).toBe('ok');
  });

  it("the entry can carry the member's own goal, and updates that goal", async () => {
    const w = buildWorld();
    await w.timeEntries.create(
      MEMBER,
      entry(OTHERS_TASK, { goalId: 'g-member' }) as any,
    );
    expect(w.goals.progressCalls).toEqual([
      { goalId: 'g-member', userId: MEMBER },
    ]);
  });

  it("but never another member's goal or schedule block", async () => {
    const w = buildWorld();
    expect(
      await outcome(() =>
        w.timeEntries.create(
          MEMBER,
          entry(OTHERS_TASK, { goalId: 'g-admin' }) as any,
        ),
      ),
    ).toBe(403);
    expect(
      await outcome(() =>
        w.timeEntries.create(
          MEMBER,
          entry(OTHERS_TASK, { scheduleBlockId: 'sb-admin' }) as any,
        ),
      ),
    ).toBe(403);
  });

  it('a guest is refused', async () => {
    const w = buildWorld();
    expect(
      await outcome(() =>
        w.timeEntries.create(GUEST, entry(OTHERS_TASK) as any),
      ),
    ).toBe(403);
    expect(w.db.tables.timeEntry ?? []).toEqual([]);
  });

  it('a non-member is refused with the same response as a task that does not exist', async () => {
    const w = buildWorld();
    const real = w.timeEntries.create(OUTSIDER, entry(OTHERS_TASK) as any);
    const fake = w.timeEntries.create(
      OUTSIDER,
      entry('t-does-not-exist') as any,
    );
    await expect(real).rejects.toMatchObject({
      status: 403,
      message: 'Task not found or access denied',
    });
    await expect(fake).rejects.toMatchObject({
      status: 403,
      message: 'Task not found or access denied',
    });
  });

  it("someone else's personal task is still refused", async () => {
    const w = buildWorld();
    expect(
      await outcome(() =>
        w.timeEntries.create(MEMBER, entry('t-admin-personal') as any),
      ),
    ).toBe(403);
  });

  it('an existing entry can be moved onto a writable project task', async () => {
    const w = buildWorld();
    const mine: any = await w.timeEntries.create(
      MEMBER,
      entry('t-member-personal') as any,
    );
    const updated: any = await w.timeEntries.update(MEMBER, mine.id, {
      taskId: OTHERS_TASK,
    } as any);
    expect(updated.taskId).toBe(OTHERS_TASK);
    expect(updated.taskTitle).toBe('Member2 project task');

    expect(
      await outcome(() =>
        w.timeEntries.update(MEMBER, mine.id, {
          taskId: 't-admin-personal',
        } as any),
      ),
    ).toBe(403);
  });
});

describe('active timer on project tasks', () => {
  it("a member runs the timer on another member's project task", async () => {
    const w = buildWorld();
    const session: any = await w.timer.start(MEMBER, {
      taskId: OTHERS_TASK,
    } as any);
    expect(session.taskId).toBe(OTHERS_TASK);
    expect(session.task).toMatchObject({
      id: OTHERS_TASK,
      title: 'Member2 project task',
    });

    const stopped: any = await w.timer.stop(MEMBER, {});
    expect(stopped.timeEntry).toMatchObject({
      userId: MEMBER,
      taskId: OTHERS_TASK,
      taskTitle: 'Member2 project task',
      source: 'TRACKER',
    });
  });

  it('a member can attach a project task to a running timer', async () => {
    const w = buildWorld();
    await w.timer.start(MEMBER, {} as any);
    const updated: any = await w.timer.updateAttribution(MEMBER, {
      taskId: OTHERS_TASK,
    } as any);
    expect(updated.taskId).toBe(OTHERS_TASK);
  });

  it('a guest and a non-member are refused', async () => {
    for (const actor of [GUEST, OUTSIDER]) {
      const w = buildWorld();
      expect(
        await outcome(() =>
          w.timer.start(actor, { taskId: OTHERS_TASK } as any),
        ),
      ).toBe(400);
      expect(w.db.tables.activeTimerSession ?? []).toEqual([]);
    }
  });

  it("a member still cannot attach another member's goal", async () => {
    const w = buildWorld();
    expect(
      await outcome(() =>
        w.timer.start(MEMBER, {
          taskId: OTHERS_TASK,
          goalId: 'g-admin',
        } as any),
      ),
    ).toBe(400);
  });
});
