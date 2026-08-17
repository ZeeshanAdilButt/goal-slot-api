import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { SharingService } from './sharing.service';

class FakePrismaForMarkViewed {
  rows = new Map<string, any>();

  sharedAccess = {
    findUnique: async ({ where }: any) => this.rows.get(where.id) ?? null,
    update: async ({ where, data }: any) => {
      const existing = this.rows.get(where.id);
      const updated = { ...existing, ...data };
      this.rows.set(where.id, updated);
      return updated;
    },
  };
}

function buildMarkViewedService() {
  const prisma = new FakePrismaForMarkViewed();
  const emailService = {} as any;
  const service = new SharingService(prisma as any, emailService);

  return { prisma, service };
}

describe('SharingService.markViewed', () => {
  it('sets lastViewedAt when the caller is the mentor holding access', async () => {
    const { prisma, service } = buildMarkViewedService();
    prisma.rows.set('share_1', {
      id: 'share_1',
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      lastViewedAt: null,
    });

    const result = await service.markViewed('share_1', 'mentor_1');

    expect(result.lastViewedAt).toBeInstanceOf(Date);
    expect(prisma.rows.get('share_1').lastViewedAt).toBeInstanceOf(Date);
  });

  it('rejects the mentee who owns the data', async () => {
    const { prisma, service } = buildMarkViewedService();
    prisma.rows.set('share_1', {
      id: 'share_1',
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      lastViewedAt: null,
    });

    await expect(service.markViewed('share_1', 'mentee_1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.rows.get('share_1').lastViewedAt).toBeNull();
  });

  it('rejects an unrelated user', async () => {
    const { prisma, service } = buildMarkViewedService();
    prisma.rows.set('share_1', {
      id: 'share_1',
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      lastViewedAt: null,
    });

    await expect(service.markViewed('share_1', 'stranger_1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws NotFoundException for a nonexistent share', async () => {
    const { service } = buildMarkViewedService();

    await expect(service.markViewed('missing', 'mentor_1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ---------- Fakes for verifyPublicToken ----------

function makeShare(overrides: Partial<any> & { inviteToken: string }) {
  return {
    id: overrides.id ?? 'share_1',
    ownerId: overrides.ownerId ?? 'owner_1',
    sharedWithId: overrides.sharedWithId ?? null,
    inviteEmail: overrides.inviteEmail ?? null,
    inviteToken: overrides.inviteToken,
    inviteExpires: overrides.inviteExpires ?? null,
    isPublicLink: overrides.isPublicLink ?? false,
    accessLevel: overrides.accessLevel ?? 'VIEW',
    isAccepted: overrides.isAccepted ?? false,
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
    owner: overrides.owner ?? {
      id: 'owner_1',
      email: 'owner@example.com',
      name: 'Owner',
      avatar: null,
    },
  };
}

class FakePrismaForPublicToken {
  shares: any[] = [];

  sharedAccess = {
    findUnique: async ({ where }: any) => {
      return (
        this.shares.find((s) => {
          if (
            where.inviteToken !== undefined &&
            s.inviteToken !== where.inviteToken
          ) {
            return false;
          }
          if (
            where.isPublicLink !== undefined &&
            s.isPublicLink !== where.isPublicLink
          ) {
            return false;
          }
          return true;
        }) ?? null
      );
    },
  };

  goal = {
    findMany: async () => [{ id: 'goal_1', title: 'Ship the feature' }],
  };

  timeEntry = {
    findMany: async () => [],
  };
}

class FakeEmailService {}

function buildPublicTokenService() {
  const prisma = new FakePrismaForPublicToken();
  const service = new SharingService(
    prisma as any,
    new FakeEmailService() as any,
  );
  return { prisma, service };
}

describe('SharingService.verifyPublicToken (via public endpoints)', () => {
  it('rejects a personal invite token that is not a public link from the sensitive data endpoints', async () => {
    const { prisma, service } = buildPublicTokenService();
    prisma.shares.push(
      makeShare({
        inviteToken: 'personal-invite-token',
        isPublicLink: false,
        inviteEmail: 'target@example.com',
        isAccepted: false,
      }),
    );

    await expect(
      service.getPublicSharedGoals('personal-invite-token'),
    ).rejects.toThrow(NotFoundException);
  });

  it('still resolves metadata for a personal invite token, without exposing owner data', async () => {
    // Regression coverage: opening a personal (emailed) invite link must
    // not dead-end on "link expired or invalid" the moment it's clicked.
    // The web /share/accept page's first call is always getPublicSharedData,
    // which needs to succeed for personal invites too so it can render the
    // "create an account or log in" prompt - only the goals/time-entries
    // endpoints stay restricted to genuine public links.
    const { prisma, service } = buildPublicTokenService();
    prisma.shares.push(
      makeShare({
        id: 'share_personal',
        inviteToken: 'personal-invite-token',
        isPublicLink: false,
        inviteEmail: 'target@example.com',
        isAccepted: false,
      }),
    );

    const data = await service.getPublicSharedData('personal-invite-token');
    expect(data.shareId).toBe('share_personal');
    expect(data.isPublicLink).toBe(false);
    expect(data.inviteEmail).toBe('target@example.com');
    expect(data).not.toHaveProperty('goals');
    expect(data).not.toHaveProperty('recentEntries');
  });

  it('still enforces expiry for a personal invite token on the metadata endpoint', async () => {
    const { prisma, service } = buildPublicTokenService();
    prisma.shares.push(
      makeShare({
        inviteToken: 'expired-personal-token',
        isPublicLink: false,
        inviteExpires: new Date('2020-01-01T00:00:00Z'),
      }),
    );

    await expect(
      service.getPublicSharedData('expired-personal-token'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('accepts a genuine public link token', async () => {
    const { prisma, service } = buildPublicTokenService();
    prisma.shares.push(
      makeShare({
        id: 'share_public',
        inviteToken: 'public-link-token',
        isPublicLink: true,
      }),
    );

    const goals = await service.getPublicSharedGoals('public-link-token');
    expect(goals).toEqual([{ id: 'goal_1', title: 'Ship the feature' }]);

    const data = await service.getPublicSharedData('public-link-token');
    expect(data.shareId).toBe('share_public');
    expect(data.isPublicLink).toBe(true);
  });

  it('still rejects an unknown token', async () => {
    const { service } = buildPublicTokenService();
    await expect(
      service.getPublicSharedGoals('does-not-exist'),
    ).rejects.toThrow(NotFoundException);
  });
});

// ---------- Public-link field projection ----------
//
// getPublicSharedGoals answers an unauthenticated request (anyone holding
// the link). It used to be a bare findMany with no `select`, so every Goal
// column went out on the wire -- notably `description`, free-form prose the
// owner never chose to publish. The public page only ever renders
// title/color/hours, so the leak was invisible in the UI and visible only
// in the JSON response.

class FakePrismaWithGoalSelect {
  shares: any[] = [];
  lastGoalFindManyArgs: any = null;

  // The full row as Prisma would return it with no `select`.
  private readonly storedGoal = {
    id: 'goal_1',
    title: 'Ship the feature',
    description: '<p>Private notes: negotiating an offer at BigCo</p>',
    category: 'Career',
    targetHours: 40,
    loggedHours: 12.5,
    deadline: null,
    status: 'ACTIVE',
    color: '#FFD700',
    order: 0,
    templateId: null,
    templateGoalRef: null,
    userId: 'owner_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  sharedAccess = {
    findUnique: async ({ where }: any) =>
      this.shares.find((s) => {
        if (
          where.inviteToken !== undefined &&
          s.inviteToken !== where.inviteToken
        ) {
          return false;
        }
        if (
          where.isPublicLink !== undefined &&
          s.isPublicLink !== where.isPublicLink
        ) {
          return false;
        }
        return true;
      }) ?? null,
  };

  goal = {
    // Emulates Prisma's projection: with no `select` the caller gets the
    // whole row, which is exactly the bug.
    findMany: async (args: any) => {
      this.lastGoalFindManyArgs = args;
      if (!args?.select) return [{ ...this.storedGoal }];
      const projected: Record<string, unknown> = {};
      for (const [field, wanted] of Object.entries(args.select)) {
        if (wanted) projected[field] = (this.storedGoal as any)[field];
      }
      return [projected];
    },
  };

  timeEntry = { findMany: async () => [] };
}

describe('SharingService.getPublicSharedGoals field projection', () => {
  function build() {
    const prisma = new FakePrismaWithGoalSelect();
    prisma.shares.push(
      makeShare({
        id: 'share_public',
        inviteToken: 'public-link-token',
        isPublicLink: true,
      }),
    );
    const service = new SharingService(
      prisma as any,
      new FakeEmailService() as any,
    );
    return { prisma, service };
  }

  it('does not leak goal.description to an unauthenticated public-link holder', async () => {
    const { service } = build();

    const goals = await service.getPublicSharedGoals('public-link-token');

    expect(goals).toHaveLength(1);
    expect(goals[0]).not.toHaveProperty('description');
    expect(JSON.stringify(goals)).not.toContain('negotiating an offer');
  });

  it('does not leak internal columns (userId, order, template provenance) either', async () => {
    const { service } = build();

    const goals = await service.getPublicSharedGoals('public-link-token');

    expect(goals[0]).not.toHaveProperty('userId');
    expect(goals[0]).not.toHaveProperty('order');
    expect(goals[0]).not.toHaveProperty('templateId');
    expect(goals[0]).not.toHaveProperty('deadline');
  });

  it('still returns every field the public share page actually renders', async () => {
    const { service } = build();

    const goals = await service.getPublicSharedGoals('public-link-token');

    expect(goals[0]).toEqual({
      id: 'goal_1',
      title: 'Ship the feature',
      color: '#FFD700',
      category: 'Career',
      targetHours: 40,
      loggedHours: 12.5,
      status: 'ACTIVE',
    });
  });
});
