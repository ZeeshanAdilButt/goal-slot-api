import { ADMIN, GUEST, MEMBER, OUTSIDER, buildWorld, outcome } from './world';
import {
  MAX_PENDING_EMAIL_INVITES,
  newInviteToken,
} from '../project-invites.service';
import { MAX_MEMBERS_PER_PROJECT } from '../projects.service';

const P = 'p-1';
const DAY = 24 * 60 * 60 * 1000;

function memberOf(w: ReturnType<typeof buildWorld>, userId: string) {
  return w.db.tables.projectMember.find(
    (m) => m.projectId === P && m.userId === userId,
  );
}

function seedInvite(
  w: ReturnType<typeof buildWorld>,
  overrides: Record<string, unknown> = {},
) {
  return w.db.seed('projectInvite', {
    projectId: P,
    email: null,
    role: 'MEMBER',
    token: newInviteToken(),
    expiresAt: new Date(Date.now() + 7 * DAY),
    invitedById: ADMIN,
    ...overrides,
  });
}

describe('ProjectInvitesService', () => {
  describe('email invites', () => {
    it('creates one invite per email, 7-day expiry, and sends the email with the token', async () => {
      const w = buildWorld();
      const before = Date.now();

      const result = await w.invites.createEmailInvites(ADMIN, P, {
        emails: [
          'New.Person@Example.com',
          'new.person@example.com',
          'two@example.com',
        ],
        role: 'GUEST' as any,
      });

      expect(result.skipped).toEqual([]);
      expect(result.invited.map((i) => i.email)).toEqual([
        'new.person@example.com',
        'two@example.com',
      ]);
      expect(result.invited.every((i) => i.emailSent)).toBe(true);
      expect(result.invited.every((i) => i.role === 'GUEST')).toBe(true);

      const rows = w.db.tables.projectInvite;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const ttl = row.expiresAt.getTime() - before;
        expect(ttl).toBeGreaterThanOrEqual(7 * DAY - 1000);
        expect(ttl).toBeLessThanOrEqual(7 * DAY + 1000);
        // 32 random bytes, base64url.
        expect(row.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      }

      expect(w.email.sent).toHaveLength(2);
      expect(w.email.sent[0]).toMatchObject({
        toEmail: 'new.person@example.com',
        inviterName: 'Ada Admin',
        projectName: 'Launch',
        role: 'GUEST',
        inviteToken: rows[0].token,
      });
    });

    it('skips and reports people who are already members (email matched case-insensitively)', async () => {
      const w = buildWorld();
      const result = await w.invites.createEmailInvites(ADMIN, P, {
        emails: [`${MEMBER.toUpperCase()}@EXAMPLE.COM`, 'fresh@example.com'],
      });

      expect(result.skipped).toEqual([
        { email: `${MEMBER}@example.com`, reason: 'already_member' },
      ]);
      expect(result.invited.map((i) => i.email)).toEqual(['fresh@example.com']);
    });

    it('re-inviting a pending email refreshes its token and expiry instead of duplicating it', async () => {
      const w = buildWorld();
      await w.invites.createEmailInvites(ADMIN, P, {
        emails: ['again@example.com'],
      });
      const first = { ...w.db.tables.projectInvite[0] };

      const second = await w.invites.createEmailInvites(ADMIN, P, {
        emails: ['again@example.com'],
        role: 'ADMIN' as any,
      });

      expect(second.invited).toEqual([]);
      expect(second.skipped).toEqual([
        { email: 'again@example.com', reason: 'pending_refreshed' },
      ]);
      // The refreshed token is emailed again, since the old link is now dead.
      expect(w.email.sent.at(-1).inviteToken).toBe(
        w.db.tables.projectInvite[0].token,
      );
      expect(w.db.tables.projectInvite).toHaveLength(1);
      const row = w.db.tables.projectInvite[0];
      expect(row.id).toBe(first.id);
      expect(row.token).not.toBe(first.token);
      expect(row.role).toBe('ADMIN');
    });

    it('still records the invite when the email fails to send', async () => {
      const w = buildWorld();
      w.email.fail = true;
      const result = await w.invites.createEmailInvites(ADMIN, P, {
        emails: ['x@example.com'],
      });
      expect(result.invited[0].emailSent).toBe(false);
      expect(w.db.tables.projectInvite).toHaveLength(1);
    });

    it(`caps pending email invites at ${MAX_PENDING_EMAIL_INVITES}`, async () => {
      const w = buildWorld();
      for (let i = 0; i < MAX_PENDING_EMAIL_INVITES; i++) {
        seedInvite(w, { email: `p${i}@example.com` });
      }
      expect(
        await outcome(() =>
          w.invites.createEmailInvites(ADMIN, P, {
            emails: ['one-more@example.com'],
          }),
        ),
      ).toBe(400);
      // Refreshing one that is already pending does not add to the count.
      expect(
        await outcome(() =>
          w.invites.createEmailInvites(ADMIN, P, {
            emails: ['p0@example.com'],
          }),
        ),
      ).toBe('ok');
    });

    it('lists pending email invites without exposing tokens', async () => {
      const w = buildWorld();
      await w.invites.createEmailInvites(ADMIN, P, {
        emails: ['a@example.com'],
      });
      seedInvite(w); // the link invite is not an email invite
      const list = await w.invites.list(ADMIN, P);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        email: 'a@example.com',
        role: 'MEMBER',
        expired: false,
      });
      expect(list[0]).not.toHaveProperty('token');
      expect(list[0].invitedBy).toMatchObject({ id: ADMIN, name: 'Ada Admin' });
    });

    it('resend issues a fresh token and emails it; revoke marks it revoked', async () => {
      const w = buildWorld();
      const { invited } = await w.invites.createEmailInvites(ADMIN, P, {
        emails: ['r@example.com'],
      });
      const oldToken = w.db.tables.projectInvite[0].token;

      await w.invites.resend(ADMIN, P, invited[0].id);
      const newToken = w.db.tables.projectInvite[0].token;
      expect(newToken).not.toBe(oldToken);
      expect(w.email.sent.at(-1).inviteToken).toBe(newToken);

      await w.invites.revoke(ADMIN, P, invited[0].id);
      expect(w.db.tables.projectInvite[0].revokedAt).toBeInstanceOf(Date);
      expect(await w.invites.list(ADMIN, P)).toEqual([]);
    });
  });

  describe('link invite', () => {
    it('creates the link once and returns the same one afterwards', async () => {
      const w = buildWorld();
      const a = await w.invites.getOrCreateLink(ADMIN, P, {});
      const b = await w.invites.getOrCreateLink(ADMIN, P, {});

      expect(a.token).toBe(b.token);
      expect(a.role).toBe('MEMBER');
      expect(a.inviteLink).toBe(`/projects/invite?token=${a.token}`);
      expect(w.db.tables.projectInvite).toHaveLength(1);
      expect(w.db.tables.projectInvite[0].email).toBeNull();
    });

    it('switches the role of the live link when asked', async () => {
      const w = buildWorld();
      const a = await w.invites.getOrCreateLink(ADMIN, P, {});
      const b = await w.invites.getOrCreateLink(ADMIN, P, {
        role: 'GUEST' as any,
      });
      expect(b.token).toBe(a.token);
      expect(b.role).toBe('GUEST');
    });

    it('after revoking, the old link is dead and a new one is issued', async () => {
      const w = buildWorld();
      const a = await w.invites.getOrCreateLink(ADMIN, P, {});
      await w.invites.revokeLink(ADMIN, P);

      expect(await outcome(() => w.invites.accept(OUTSIDER, a.token))).toBe(
        410,
      );
      const b = await w.invites.getOrCreateLink(ADMIN, P, {});
      expect(b.token).not.toBe(a.token);
    });
  });

  describe('accept', () => {
    it('an email invite accepts when the signed-in email matches, case-insensitively', async () => {
      const w = buildWorld();
      const invite = seedInvite(w, {
        email: `${OUTSIDER.toUpperCase()}@Example.COM`,
        role: 'GUEST',
      });

      const result = await w.invites.accept(OUTSIDER, invite.token);

      expect(result).toEqual({
        projectId: P,
        role: 'GUEST',
        alreadyMember: false,
      });
      expect(memberOf(w, OUTSIDER)?.role).toBe('GUEST');
      expect(w.db.tables.projectInvite[0].acceptedAt).toBeInstanceOf(Date);
    });

    it('an email invite for a different address is 403 with a clear message, and adds nobody', async () => {
      const w = buildWorld();
      const invite = seedInvite(w, { email: 'someone-else@example.com' });

      await expect(
        w.invites.accept(OUTSIDER, invite.token),
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('different email address'),
      });
      expect(memberOf(w, OUTSIDER)).toBeUndefined();
    });

    it('a link invite accepts for anyone signed in, and stays usable', async () => {
      const w = buildWorld();
      const link = await w.invites.getOrCreateLink(ADMIN, P, {
        role: 'GUEST' as any,
      });

      expect(await w.invites.accept(OUTSIDER, link.token)).toMatchObject({
        role: 'GUEST',
        alreadyMember: false,
      });
      expect(memberOf(w, OUTSIDER)?.role).toBe('GUEST');
      // Multi-use: no acceptedAt is stamped on a link invite.
      expect(w.db.tables.projectInvite[0].acceptedAt).toBeNull();
    });

    it('an expired invite is 410', async () => {
      const w = buildWorld();
      const invite = seedInvite(w, { expiresAt: new Date(Date.now() - 1000) });
      expect(
        await outcome(() => w.invites.accept(OUTSIDER, invite.token)),
      ).toBe(410);
      expect(memberOf(w, OUTSIDER)).toBeUndefined();
    });

    it('a revoked invite is 410', async () => {
      const w = buildWorld();
      const invite = seedInvite(w, {
        email: `${OUTSIDER}@example.com`,
        revokedAt: new Date(),
      });
      expect(
        await outcome(() => w.invites.accept(OUTSIDER, invite.token)),
      ).toBe(410);
    });

    it('an email invite is single use', async () => {
      const w = buildWorld();
      const invite = seedInvite(w, { email: `${OUTSIDER}@example.com` });
      await w.invites.accept(OUTSIDER, invite.token);
      await w.projects.removeMember(OUTSIDER, P, OUTSIDER);
      expect(
        await outcome(() => w.invites.accept(OUTSIDER, invite.token)),
      ).toBe(410);
    });

    it('accepting when already a member is idempotent and keeps the existing role', async () => {
      const w = buildWorld();
      const link = await w.invites.getOrCreateLink(ADMIN, P, {
        role: 'GUEST' as any,
      });

      const result = await w.invites.accept(MEMBER, link.token);

      expect(result).toEqual({
        projectId: P,
        role: 'MEMBER',
        alreadyMember: true,
      });
      expect(
        w.db.tables.projectMember.filter(
          (m) => m.userId === MEMBER && m.projectId === P,
        ),
      ).toHaveLength(1);
    });

    it('a double accept of the same invite creates one membership', async () => {
      const w = buildWorld();
      const invite = seedInvite(w, { email: `${OUTSIDER}@example.com` });
      await w.invites.accept(OUTSIDER, invite.token);
      expect(await w.invites.accept(OUTSIDER, invite.token)).toMatchObject({
        alreadyMember: true,
      });
      expect(
        w.db.tables.projectMember.filter((m) => m.userId === OUTSIDER),
      ).toHaveLength(1);
    });

    it('an unknown token is 404', async () => {
      const w = buildWorld();
      expect(await outcome(() => w.invites.accept(OUTSIDER, 'nope'))).toBe(404);
      expect(await outcome(() => w.invites.preview(OUTSIDER, 'nope'))).toBe(
        404,
      );
    });

    it(`refuses to grow a project past ${MAX_MEMBERS_PER_PROJECT} members`, async () => {
      const w = buildWorld();
      for (
        let i = w.db.tables.projectMember.length;
        i < MAX_MEMBERS_PER_PROJECT;
        i++
      ) {
        w.db.seed('projectMember', {
          projectId: P,
          userId: `filler-${i}`,
          role: 'MEMBER',
        });
      }
      const link = await w.invites.getOrCreateLink(ADMIN, P, {});
      expect(await outcome(() => w.invites.accept(OUTSIDER, link.token))).toBe(
        409,
      );
    });
  });

  describe('preview', () => {
    it('shows project, inviter, role and state without needing membership', async () => {
      const w = buildWorld();
      const invite = seedInvite(w, {
        email: `${OUTSIDER}@example.com`,
        role: 'ADMIN',
      });

      expect(await w.invites.preview(OUTSIDER, invite.token)).toEqual({
        projectId: P,
        projectName: 'Launch',
        color: '#16A34A',
        inviterName: 'Ada Admin',
        role: 'ADMIN',
        expired: false,
        revoked: false,
        alreadyMember: false,
        emailMatches: true,
        email: 'u-***@example.com',
      });
    });

    it('flags expired, wrong email and already-member states', async () => {
      const w = buildWorld();
      const expired = seedInvite(w, {
        email: 'x@example.com',
        expiresAt: new Date(Date.now() - 1),
      });
      const p = await w.invites.preview(GUEST, expired.token);
      expect(p).toMatchObject({
        expired: true,
        emailMatches: false,
        alreadyMember: true,
        email: 'x***@example.com',
      });

      const link = seedInvite(w);
      expect(await w.invites.preview(OUTSIDER, link.token)).toMatchObject({
        expired: false,
        emailMatches: true,
        alreadyMember: false,
        email: null,
      });
    });
  });
});
