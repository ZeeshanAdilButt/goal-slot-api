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
  it('rejects a personal invite token that is not a public link', async () => {
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
    await expect(
      service.getPublicSharedData('personal-invite-token'),
    ).rejects.toThrow(NotFoundException);
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
