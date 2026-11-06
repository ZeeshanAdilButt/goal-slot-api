import {
  ADMIN,
  GUEST,
  MEMBER,
  MEMBER2,
  OUTSIDER,
  buildWorld,
  outcome,
} from './world';
import { MAX_PROJECTS_CREATED_PER_USER } from '../projects.service';

const P = 'p-1';

describe('ProjectsService', () => {
  describe('create and list', () => {
    it('makes the creator ADMIN and returns the project with role ADMIN', async () => {
      const w = buildWorld();
      const created = await w.projects.create(OUTSIDER, {
        name: 'Side project',
      });

      expect(created).toMatchObject({
        name: 'Side project',
        color: '#2563EB',
        role: 'ADMIN',
        memberCount: 1,
        openTaskCount: 0,
      });
      const member = w.db.tables.projectMember.find(
        (m) => m.projectId === created.id && m.userId === OUTSIDER,
      );
      expect(member?.role).toBe('ADMIN');
    });

    it('lists only projects I belong to, with role, member and open task counts', async () => {
      const w = buildWorld();
      await w.projects.create(OUTSIDER, { name: 'Not yours' });

      const mine = await w.projects.list(GUEST);
      expect(mine).toEqual([
        {
          id: P,
          name: 'Launch',
          color: '#16A34A',
          role: 'GUEST',
          memberCount: 4,
          openTaskCount: 3,
        },
      ]);
    });

    it('does not count DONE tasks as open', async () => {
      const w = buildWorld();
      w.db.tables.task.find((t) => t.id === 't-member-project')!.status =
        'DONE';
      const [p] = await w.projects.list(ADMIN);
      expect(p.openTaskCount).toBe(2);
    });

    it('leaves archived projects out of the list but keeps them readable by id', async () => {
      const w = buildWorld();
      await w.projects.update(ADMIN, P, { archived: true });

      expect(await w.projects.list(MEMBER)).toEqual([]);
      const detail = await w.projects.findOne(MEMBER, P);
      expect(detail.archivedAt).toBeInstanceOf(Date);

      await w.projects.update(ADMIN, P, { archived: false });
      expect(await w.projects.list(MEMBER)).toHaveLength(1);
    });

    it(`caps creation at ${MAX_PROJECTS_CREATED_PER_USER} projects per user`, async () => {
      const w = buildWorld();
      for (let i = 0; i < MAX_PROJECTS_CREATED_PER_USER; i++) {
        w.db.seed('project', { name: `p${i}`, createdById: OUTSIDER });
      }
      expect(
        await outcome(() => w.projects.create(OUTSIDER, { name: 'one more' })),
      ).toBe(400);
    });

    it('deleting a project deletes its tasks but keeps logged time', async () => {
      const w = buildWorld();
      w.db.seed('timeEntry', {
        id: 'te-1',
        userId: MEMBER,
        taskId: 't-member-project',
        duration: 30,
        date: new Date(),
      });

      await w.projects.remove(ADMIN, P);

      expect(w.db.tables.task.filter((t) => t.projectId === P)).toEqual([]);
      expect(
        w.db.tables.projectMember.filter((m) => m.projectId === P),
      ).toEqual([]);
      const entry = w.db.tables.timeEntry.find((e) => e.id === 'te-1');
      expect(entry).toBeDefined();
      expect(entry!.taskId).toBeNull();
    });
  });

  describe('members', () => {
    it('shows email addresses to ADMINs only', async () => {
      const w = buildWorld();

      const asAdmin = await w.projects.listMembers(ADMIN, P);
      expect(asAdmin.map((m) => m.email)).toEqual([
        `${ADMIN}@example.com`,
        `${MEMBER}@example.com`,
        `${MEMBER2}@example.com`,
        `${GUEST}@example.com`,
      ]);

      for (const actor of [MEMBER, GUEST]) {
        const list = await w.projects.listMembers(actor, P);
        expect(list.every((m) => m.email === null)).toBe(true);
        expect(list[0]).toMatchObject({
          userId: ADMIN,
          name: 'Ada Admin',
          role: 'ADMIN',
        });
        expect(list[0].joinedAt).toBeInstanceOf(Date);
      }
    });
  });

  describe('last ADMIN rules', () => {
    it('the last ADMIN cannot leave', async () => {
      const w = buildWorld();
      expect(
        await outcome(() => w.projects.removeMember(ADMIN, P, ADMIN)),
      ).toBe(409);
      expect(w.db.tables.projectMember.some((m) => m.userId === ADMIN)).toBe(
        true,
      );
    });

    it('the last ADMIN cannot be demoted', async () => {
      const w = buildWorld();
      expect(
        await outcome(() =>
          w.projects.updateMemberRole(ADMIN, P, ADMIN, {
            role: 'MEMBER' as any,
          }),
        ),
      ).toBe(409);
    });

    it('after one ADMIN removes the other, the remaining one is the last and cannot leave', async () => {
      const w = buildWorld();
      // A second admin exists only long enough to try removing the first.
      await w.projects.updateMemberRole(ADMIN, P, MEMBER, {
        role: 'ADMIN' as any,
      });
      await w.projects.removeMember(MEMBER, P, ADMIN);
      expect(
        await outcome(() => w.projects.removeMember(MEMBER, P, MEMBER)),
      ).toBe(409);
    });

    it('an ADMIN can step down once someone else is ADMIN', async () => {
      const w = buildWorld();
      await w.projects.updateMemberRole(ADMIN, P, MEMBER, {
        role: 'ADMIN' as any,
      });
      expect(
        await outcome(() =>
          w.projects.updateMemberRole(ADMIN, P, ADMIN, {
            role: 'MEMBER' as any,
          }),
        ),
      ).toBe('ok');
    });

    it('changing a role for someone who is not a member is 404', async () => {
      const w = buildWorld();
      expect(
        await outcome(() =>
          w.projects.updateMemberRole(ADMIN, P, OUTSIDER, {
            role: 'GUEST' as any,
          }),
        ),
      ).toBe(404);
    });
  });

  describe('removing a member', () => {
    it('unassigns their tasks in that project and nowhere else', async () => {
      const w = buildWorld();
      // MEMBER is assigned t-member2-project here, and a task in another project.
      const other = w.db.seed('project', {
        id: 'p-2',
        name: 'Other',
        createdById: MEMBER2,
      });
      w.db.seed('projectMember', {
        projectId: other.id,
        userId: MEMBER2,
        role: 'ADMIN',
      });
      w.db.seed('projectMember', {
        projectId: other.id,
        userId: MEMBER,
        role: 'MEMBER',
      });
      w.db.seed('task', {
        id: 't-other',
        title: 'elsewhere',
        userId: MEMBER2,
        projectId: other.id,
        assigneeId: MEMBER,
      });

      await w.projects.removeMember(ADMIN, P, MEMBER);

      const byId = (id: string) => w.db.tables.task.find((t) => t.id === id)!;
      expect(byId('t-member2-project').assigneeId).toBeNull();
      expect(byId('t-other').assigneeId).toBe(MEMBER);
      expect(
        w.db.tables.projectMember.some(
          (m) => m.projectId === P && m.userId === MEMBER,
        ),
      ).toBe(false);
    });

    it('leaving unassigns the leaver too', async () => {
      const w = buildWorld();
      await w.projects.removeMember(MEMBER, P, MEMBER);
      expect(
        w.db.tables.task.find((t) => t.id === 't-member2-project')!.assigneeId,
      ).toBeNull();
    });
  });
});
