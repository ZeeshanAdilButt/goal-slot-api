import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InstructionsService } from './instructions.service';
import { ReminderDispatchService } from '../reminders/reminder-dispatch.service';
import { ReminderChannel, ReminderChannelInput, ReminderChannelResult } from '../reminders/reminder-channel.interface';

class FakePrisma {
  shares: any[] = [];
  instructions = new Map<string, any>();
  notifications: any[] = [];
  private nextId = 1;

  sharedAccess = {
    findFirst: async ({ where }: any) => {
      return (
        this.shares.find((share) =>
          Object.entries(where).every(([key, value]) => share[key] === value),
        ) ?? null
      );
    },
    // Only used indirectly, via ReminderDispatchService.runDailySweep's
    // report-staleness pass, which these instruction-focused tests don't
    // exercise beyond making sure it doesn't blow up.
    findMany: async () => [],
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
    findMany: async (): Promise<any[]> => [],
  };

  notification = {
    create: async ({ data }: any) => {
      const row = { id: `notif_${this.notifications.length + 1}`, ...data };
      this.notifications.push(row);
      return row;
    },
  };
}

class RecordingChannel implements ReminderChannel {
  calls: ReminderChannelInput[] = [];

  constructor(
    public readonly name: string,
    private readonly result: ReminderChannelResult = { ok: true },
    private readonly shouldReject = false,
  ) {}

  async send(input: ReminderChannelInput): Promise<ReminderChannelResult> {
    this.calls.push(input);
    if (this.shouldReject) {
      throw new Error(`${this.name} exploded`);
    }
    return this.result;
  }
}

function buildService(channels: ReminderChannel[] = [new RecordingChannel('email')]) {
  const prisma = new FakePrisma();
  const reminderDispatchService = new ReminderDispatchService(prisma as any, channels);
  const service = new InstructionsService(prisma as any, reminderDispatchService);
  return { prisma, service, channels };
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

  it('sends an immediate reminder across every channel and stamps lastReminderAt', async () => {
    const email = new RecordingChannel('email');
    const expoPush = new RecordingChannel('expo-push');
    const webPush = new RecordingChannel('web-push');
    const { prisma, service } = buildService([email, expoPush, webPush]);
    prisma.shares.push({
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      isAccepted: true,
    });

    const NOW = new Date('2026-08-13T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      const instruction = await service.assign('mentor_1', {
        assigneeId: 'mentee_1',
        title: 'Start tracking your time again',
      });

      for (const channel of [email, expoPush, webPush]) {
        expect(channel.calls).toHaveLength(1);
        expect(channel.calls[0].userId).toBe('mentee_1');
        expect(channel.calls[0].title).toContain('Start tracking your time again');
        expect(channel.calls[0].data).toEqual({ type: 'instruction', instructionId: instruction.id });
      }

      const stored = prisma.instructions.get(instruction.id);
      expect(stored.lastReminderAt).toEqual(NOW);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still creates the instruction when every notification channel fails', async () => {
    const rejecting = new RecordingChannel('web-push', { ok: false }, true);
    const { prisma, service } = buildService([rejecting]);
    prisma.shares.push({
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      isAccepted: true,
    });

    const instruction = await service.assign('mentor_1', {
      assigneeId: 'mentee_1',
      title: 'Log time daily this week',
    });

    expect(instruction.status).toBe('PENDING');
    expect(rejecting.calls).toHaveLength(1);
    const stored = prisma.instructions.get(instruction.id);
    expect(stored.lastReminderAt).toBeNull();
  });

  it('does not double-send when the daily sweep runs the same day an instruction was just assigned', async () => {
    const email = new RecordingChannel('email');
    const { prisma, service } = buildService([email]);
    prisma.shares.push({
      ownerId: 'mentee_1',
      sharedWithId: 'mentor_1',
      isAccepted: true,
    });

    const NOW = new Date('2026-08-13T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      await service.assign('mentor_1', {
        assigneeId: 'mentee_1',
        title: 'Start tracking your time again',
      });
      expect(email.calls).toHaveLength(1);

      // The daily sweep looks for PENDING instructions directly against the
      // prisma layer, so make the stored row (with lastReminderAt now set)
      // visible to findMany the way a real query would.
      prisma.instruction.findMany = async () => Array.from(prisma.instructions.values());

      const reminderDispatchService = (service as any).reminderDispatchService;
      await reminderDispatchService.runDailySweep();

      expect(email.calls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
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
