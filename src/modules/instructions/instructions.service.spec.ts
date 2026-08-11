import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InstructionsService } from './instructions.service';

class FakePrisma {
  shares: any[] = [];
  instructions = new Map<string, any>();
  private nextId = 1;

  sharedAccess = {
    findFirst: async ({ where }: any) => {
      return (
        this.shares.find((share) =>
          Object.entries(where).every(([key, value]) => share[key] === value),
        ) ?? null
      );
    },
  };

  instruction = {
    create: async ({ data }: any) => {
      const row = {
        id: `instruction_${this.nextId++}`,
        completedAt: null,
        lastReminderAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.instructions.set(row.id, row);
      return row;
    },
    findUnique: async ({ where }: any) => this.instructions.get(where.id) ?? null,
    update: async ({ where, data }: any) => {
      const existing = this.instructions.get(where.id);
      const updated = { ...existing, ...data };
      this.instructions.set(where.id, updated);
      return updated;
    },
    findMany: async () => [],
  };
}

function buildService() {
  const prisma = new FakePrisma();
  const service = new InstructionsService(prisma as any);
  return { prisma, service };
}

describe('InstructionsService.assign', () => {
  it('succeeds when an accepted share exists with the assigner on the sharedWith side', async () => {
    const { prisma, service } = buildService();
    prisma.shares.push({
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      isAccepted: true,
    });

    const instruction = await service.assign('mentor_1', {
      assigneeId: 'mentee_1',
      title: 'Log time daily this week',
    });

    expect(instruction.assignerId).toBe('mentor_1');
    expect(instruction.assigneeId).toBe('mentee_1');
    expect(instruction.status).toBe('PENDING');
  });

  it('rejects when no share exists between the two users at all', async () => {
    const { service } = buildService();

    await expect(
      service.assign('mentor_1', { assigneeId: 'mentee_1', title: 'Log time' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when the share exists but has not been accepted', async () => {
    const { prisma, service } = buildService();
    prisma.shares.push({
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      isAccepted: false,
    });

    await expect(
      service.assign('mentor_1', { assigneeId: 'mentee_1', title: 'Log time' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when the share runs the other way (assignee is the sharedWith side, not the owner)', async () => {
    const { prisma, service } = buildService();
    // mentee_1 shared their access with mentor_1's data - i.e. mentee_1 can
    // view mentor_1, not the other way around. This must not authorize
    // mentor_1 to assign an instruction to mentee_1.
    prisma.shares.push({
      ownerId: 'mentor_1',
      sharedWithId: 'mentee_1',
      isAccepted: true,
    });

    await expect(
      service.assign('mentor_1', { assigneeId: 'mentee_1', title: 'Log time' }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('InstructionsService.complete', () => {
  it('succeeds for the real assignee and sets status/completedAt', async () => {
    const { prisma, service } = buildService();
    prisma.shares.push({
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      isAccepted: true,
    });
    const created = await service.assign('mentor_1', {
      assigneeId: 'mentee_1',
      title: 'Log time',
    });

    const completed = await service.complete(created.id, 'mentee_1');

    expect(completed.status).toBe('DONE');
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it('rejects completion by anyone other than the assignee', async () => {
    const { prisma, service } = buildService();
    prisma.shares.push({
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      isAccepted: true,
    });
    const created = await service.assign('mentor_1', {
      assigneeId: 'mentee_1',
      title: 'Log time',
    });

    await expect(service.complete(created.id, 'mentor_1')).rejects.toThrow(ForbiddenException);
    await expect(service.complete(created.id, 'someone_else')).rejects.toThrow(ForbiddenException);
  });

  it('rejects completion of a nonexistent instruction', async () => {
    const { service } = buildService();

    await expect(service.complete('does_not_exist', 'mentee_1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
