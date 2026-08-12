import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { SharingService } from './sharing.service';

class FakePrisma {
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

function buildService() {
  const prisma = new FakePrisma();
  const emailService = {} as any;
  const service = new SharingService(prisma as any, emailService);

  return { prisma, service };
}

describe('SharingService.markViewed', () => {
  it('sets lastViewedAt when the caller is the mentor holding access', async () => {
    const { prisma, service } = buildService();
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
    const { prisma, service } = buildService();
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
    const { prisma, service } = buildService();
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
    const { service } = buildService();

    await expect(service.markViewed('missing', 'mentor_1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
