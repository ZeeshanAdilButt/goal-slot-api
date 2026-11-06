import {
  ADMIN,
  GUEST,
  MEMBER,
  MEMBER2,
  OUTSIDER,
  World,
  buildWorld,
  outcome,
} from './world';

// The permission table from the spec, one row per action, every role.
//
//   | Action                                   | ADMIN | MEMBER    | GUEST | Non-member |
//   | see project, its tasks, members          | yes   | yes       | yes   | 404        |
//   | create/edit/move/complete/assign tasks   | yes   | yes       | 403   | 404        |
//   | delete a task                            | yes   | own only  | 403   | 404        |
//   | rename/recolor/archive/delete project    | yes   | 403       | 403   | 404        |
//   | invite/revoke/change roles/remove        | yes   | 403       | 403   | 404        |
//
// Every case starts from a fresh world, because several of them mutate it.

type Expect = 'ok' | 403 | 404;
type Row = [
  string,
  (w: World, actor: string) => Promise<unknown>,
  Expect,
  Expect,
  Expect,
  Expect,
];

const P = 'p-1';

const table: Row[] = [
  // ----- read -----
  [
    'see the project',
    (w, a) => w.projects.findOne(a, P),
    'ok',
    'ok',
    'ok',
    404,
  ],
  [
    'list the project tasks',
    (w, a) => w.tasksService.findAll(a, { projectId: P }),
    'ok',
    'ok',
    'ok',
    404,
  ],
  [
    'see a project task',
    (w, a) => w.tasksService.findOne(a, 't-member2-project'),
    'ok',
    'ok',
    'ok',
    404,
  ],
  [
    'see the members',
    (w, a) => w.projects.listMembers(a, P),
    'ok',
    'ok',
    'ok',
    404,
  ],

  // ----- task writes (on a task someone else created) -----
  [
    'create a task',
    (w, a) => w.tasksService.create(a, { title: 'New', projectId: P }),
    'ok',
    'ok',
    403,
    404,
  ],
  [
    'edit a task',
    (w, a) =>
      w.tasksService.update(a, 't-member2-project', { title: 'Edited' }),
    'ok',
    'ok',
    403,
    404,
  ],
  [
    'move a task',
    (w, a) =>
      w.tasksService.update(a, 't-member2-project', { status: 'DONE' as any }),
    'ok',
    'ok',
    403,
    404,
  ],
  [
    'complete a task',
    (w, a) =>
      w.tasksService.complete(a, 't-member2-project', { actualMinutes: 30 }),
    'ok',
    'ok',
    403,
    404,
  ],
  [
    'restore a task',
    (w, a) => w.tasksService.restore(a, 't-member2-project'),
    'ok',
    'ok',
    403,
    404,
  ],
  [
    'assign a task',
    (w, a) =>
      w.tasksService.update(a, 't-member2-project', { assigneeId: MEMBER2 }),
    'ok',
    'ok',
    403,
    404,
  ],
  [
    'reorder the board',
    (w, a) =>
      w.tasksService.reorder(a, ['t-member2-project', 't-member-project'], P),
    'ok',
    'ok',
    403,
    404,
  ],

  // ----- delete -----
  [
    'delete a task someone else created',
    (w, a) => w.tasksService.delete(a, 't-member2-project'),
    'ok',
    403,
    403,
    404,
  ],

  // ----- project settings (ADMIN) -----
  [
    'rename the project',
    (w, a) => w.projects.update(a, P, { name: 'Renamed' }),
    'ok',
    403,
    403,
    404,
  ],
  [
    'recolor the project',
    (w, a) => w.projects.update(a, P, { color: '#000000' }),
    'ok',
    403,
    403,
    404,
  ],
  [
    'archive the project',
    (w, a) => w.projects.update(a, P, { archived: true }),
    'ok',
    403,
    403,
    404,
  ],
  [
    'delete the project',
    (w, a) => w.projects.remove(a, P),
    'ok',
    403,
    403,
    404,
  ],

  // ----- people (ADMIN) -----
  [
    'invite by email',
    (w, a) =>
      w.invites.createEmailInvites(a, P, { emails: ['new@example.com'] }),
    'ok',
    403,
    403,
    404,
  ],
  ['list invites', (w, a) => w.invites.list(a, P), 'ok', 403, 403, 404],
  [
    'create the invite link',
    (w, a) => w.invites.getOrCreateLink(a, P, {}),
    'ok',
    403,
    403,
    404,
  ],
  [
    'revoke the invite link',
    (w, a) => w.invites.revokeLink(a, P),
    'ok',
    403,
    403,
    404,
  ],
  [
    'change a role',
    (w, a) =>
      w.projects.updateMemberRole(a, P, MEMBER2, { role: 'GUEST' as any }),
    'ok',
    403,
    403,
    404,
  ],
  [
    'remove a member',
    (w, a) => w.projects.removeMember(a, P, MEMBER2),
    'ok',
    403,
    403,
    404,
  ],
];

const roles: Array<[string, string, number]> = [
  ['ADMIN', ADMIN, 2],
  ['MEMBER', MEMBER, 3],
  ['GUEST', GUEST, 4],
  ['non-member', OUTSIDER, 5],
];

describe('Projects permission table', () => {
  for (const row of table) {
    const [action, run] = row;
    describe(action, () => {
      for (const [label, actor, column] of roles) {
        const expected = row[column] as Expect;
        it(`${label} -> ${expected}`, async () => {
          const w = buildWorld();
          expect(await outcome(() => run(w, actor))).toBe(expected);
        });
      }
    });
  }

  it('a MEMBER may delete a task they created', async () => {
    const w = buildWorld();
    expect(
      await outcome(() => w.tasksService.delete(MEMBER, 't-member-project')),
    ).toBe('ok');
    expect(
      w.db.tables.task.find((t) => t.id === 't-member-project'),
    ).toBeUndefined();
  });

  it('revoking or resending an email invite is ADMIN only', async () => {
    const w = buildWorld();
    const { invited } = await w.invites.createEmailInvites(ADMIN, P, {
      emails: ['x@example.com'],
    });
    const id = invited[0].id;
    for (const actor of [MEMBER, GUEST]) {
      expect(await outcome(() => w.invites.resend(actor, P, id))).toBe(403);
      expect(await outcome(() => w.invites.revoke(actor, P, id))).toBe(403);
    }
    expect(await outcome(() => w.invites.resend(OUTSIDER, P, id))).toBe(404);
    expect(await outcome(() => w.invites.revoke(OUTSIDER, P, id))).toBe(404);
    expect(await outcome(() => w.invites.resend(ADMIN, P, id))).toBe('ok');
    expect(await outcome(() => w.invites.revoke(ADMIN, P, id))).toBe('ok');
  });

  it('a non-member gets 404 for a project id that does not exist either, so ids cannot be probed', async () => {
    const w = buildWorld();
    const real = await outcome(() => w.projects.findOne(OUTSIDER, P));
    const fake = await outcome(() =>
      w.projects.findOne(OUTSIDER, 'p-does-not-exist'),
    );
    expect(real).toBe(404);
    expect(fake).toBe(404);
  });

  it('everyone can leave, the ADMIN included while another ADMIN remains', async () => {
    for (const actor of [MEMBER, GUEST]) {
      const w = buildWorld();
      expect(
        await outcome(() => w.projects.removeMember(actor, P, actor)),
      ).toBe('ok');
    }
    const w = buildWorld();
    await w.projects.updateMemberRole(ADMIN, P, MEMBER, {
      role: 'ADMIN' as any,
    });
    expect(await outcome(() => w.projects.removeMember(ADMIN, P, ADMIN))).toBe(
      'ok',
    );
  });

  it('personal tasks keep the old rule: only the creator, everyone else 404', async () => {
    const w = buildWorld();
    for (const actor of [ADMIN, MEMBER2, GUEST, OUTSIDER]) {
      expect(
        await outcome(() => w.tasksService.findOne(actor, 't-member-personal')),
      ).toBe(404);
      expect(
        await outcome(() =>
          w.tasksService.update(actor, 't-member-personal', { title: 'x' }),
        ),
      ).toBe(404);
      expect(
        await outcome(() => w.tasksService.delete(actor, 't-member-personal')),
      ).toBe(404);
    }
    expect(
      await outcome(() => w.tasksService.findOne(MEMBER, 't-member-personal')),
    ).toBe('ok');
    expect(
      await outcome(() =>
        w.tasksService.update(MEMBER, 't-member-personal', { title: 'x' }),
      ),
    ).toBe('ok');
    expect(
      await outcome(() => w.tasksService.delete(MEMBER, 't-member-personal')),
    ).toBe('ok');
  });

  it('a removed member loses access to tasks they created in the project', async () => {
    const w = buildWorld();
    await w.projects.removeMember(ADMIN, P, MEMBER);
    expect(
      await outcome(() => w.tasksService.findOne(MEMBER, 't-member-project')),
    ).toBe(404);
    expect(
      await outcome(() =>
        w.tasksService.update(MEMBER, 't-member-project', { title: 'x' }),
      ),
    ).toBe(404);
  });
});
