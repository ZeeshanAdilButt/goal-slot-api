import { ReminderDispatchService, isReminderDue } from './reminder-dispatch.service';
import { ReminderChannel, ReminderChannelInput, ReminderChannelResult } from './reminder-channel.interface';

class FakePrisma {
  sharedAccesses: any[] = [];
  instructions: any[] = [];
  notifications: any[] = [];

  sharedAccess = {
    findMany: async () => this.sharedAccesses,
    update: async ({ where, data }: any) => {
      const row = this.sharedAccesses.find((s) => s.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };

  instruction = {
    findMany: async () => this.instructions,
    update: async ({ where, data }: any) => {
      const row = this.instructions.find((i) => i.id === where.id);
      Object.assign(row, data);
      return row;
    },
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

function buildService(channels: ReminderChannel[]) {
  const prisma = new FakePrisma();
  const service = new ReminderDispatchService(prisma as any, channels);
  return { prisma, service };
}

const NOW = new Date('2026-08-11T09:00:00.000Z');
const days = (n: number) => n * 24 * 60 * 60 * 1000;

describe('isReminderDue', () => {
  it('is due when there is no prior timestamp', () => {
    expect(isReminderDue(null, 7, NOW)).toBe(true);
  });

  it('is not due before the threshold has elapsed', () => {
    const recent = new Date(NOW.getTime() - days(3));
    expect(isReminderDue(recent, 7, NOW)).toBe(false);
  });

  it('is due once the threshold has elapsed', () => {
    const old = new Date(NOW.getTime() - days(8));
    expect(isReminderDue(old, 7, NOW)).toBe(true);
  });

  it('is due exactly at the threshold boundary', () => {
    const boundary = new Date(NOW.getTime() - days(7));
    expect(isReminderDue(boundary, 7, NOW)).toBe(true);
  });
});

describe('ReminderDispatchService.runDailySweep - report staleness', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires a reminder for a stale share and advances lastViewReminderAt', async () => {
    const email = new RecordingChannel('email');
    const { prisma, service } = buildService([email]);
    prisma.sharedAccesses.push({
      id: 'share_1',
      sharedWithId: 'mentor_1',
      isAccepted: true,
      lastViewedAt: new Date(NOW.getTime() - days(10)),
      lastViewReminderAt: null,
      owner: { name: 'Mentee One' },
    });

    jest.useFakeTimers().setSystemTime(NOW);
    await service.runDailySweep();

    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].userId).toBe('mentor_1');
    expect(email.calls[0].data).toEqual({ type: 'schedule', sharedAccessId: 'share_1' });
    expect(email.calls[0].title).toContain('Mentee One');
    expect(prisma.sharedAccesses[0].lastViewReminderAt).toEqual(NOW);
  });

  it('does not fire for a share viewed within the last 7 days', async () => {
    const email = new RecordingChannel('email');
    const { prisma, service } = buildService([email]);
    prisma.sharedAccesses.push({
      id: 'share_2',
      sharedWithId: 'mentor_2',
      isAccepted: true,
      lastViewedAt: new Date(NOW.getTime() - days(2)),
      lastViewReminderAt: null,
      owner: { name: 'Mentee Two' },
    });

    jest.useFakeTimers().setSystemTime(NOW);
    await service.runDailySweep();

    expect(email.calls).toHaveLength(0);
    expect(prisma.sharedAccesses[0].lastViewReminderAt).toBeNull();
  });

  it('still attempts every channel when one channel fails', async () => {
    const failing = new RecordingChannel('web-push', { ok: false }, true);
    const succeeding = new RecordingChannel('email');
    const { prisma, service } = buildService([failing, succeeding]);
    prisma.sharedAccesses.push({
      id: 'share_3',
      sharedWithId: 'mentor_3',
      isAccepted: true,
      lastViewedAt: null,
      lastViewReminderAt: null,
      owner: { name: 'Mentee Three' },
    });

    jest.useFakeTimers().setSystemTime(NOW);
    await service.runDailySweep();

    expect(failing.calls).toHaveLength(1);
    expect(succeeding.calls).toHaveLength(1);
    // One channel succeeded, so the reminder counts as delivered.
    expect(prisma.sharedAccesses[0].lastViewReminderAt).toEqual(NOW);
  });

  it('does not advance lastViewReminderAt when every channel fails', async () => {
    const rejecting = new RecordingChannel('web-push', { ok: false }, true);
    const unsuccessful = new RecordingChannel('email', { ok: false });
    const { prisma, service } = buildService([rejecting, unsuccessful]);
    prisma.sharedAccesses.push({
      id: 'share_4',
      sharedWithId: 'mentor_4',
      isAccepted: true,
      lastViewedAt: null,
      lastViewReminderAt: null,
      owner: { name: 'Mentee Four' },
    });

    jest.useFakeTimers().setSystemTime(NOW);
    await service.runDailySweep();

    expect(rejecting.calls).toHaveLength(1);
    expect(unsuccessful.calls).toHaveLength(1);
    expect(prisma.sharedAccesses[0].lastViewReminderAt).toBeNull();
  });

  it('creates an in-app SHARED_REPORT_UNVIEWED notification regardless of channel outcome', async () => {
    const failing = new RecordingChannel('email', { ok: false });
    const { prisma, service } = buildService([failing]);
    prisma.sharedAccesses.push({
      id: 'share_5',
      sharedWithId: 'mentor_5',
      isAccepted: true,
      lastViewedAt: null,
      lastViewReminderAt: null,
      owner: { name: 'Mentee Five' },
    });

    jest.useFakeTimers().setSystemTime(NOW);
    await service.runDailySweep();

    expect(prisma.notifications).toHaveLength(1);
    expect(prisma.notifications[0]).toMatchObject({
      userId: 'mentor_5',
      type: 'SHARED_REPORT_UNVIEWED',
    });
  });
});

describe('ReminderDispatchService.runDailySweep - pending instructions', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires a reminder for an instruction older than 2 days and advances lastReminderAt', async () => {
    const email = new RecordingChannel('email');
    const { prisma, service } = buildService([email]);
    prisma.instructions.push({
      id: 'instr_1',
      assigneeId: 'mentee_1',
      title: 'Log your hours',
      status: 'PENDING',
      lastReminderAt: new Date(NOW.getTime() - days(3)),
    });

    jest.useFakeTimers().setSystemTime(NOW);
    await service.runDailySweep();

    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].userId).toBe('mentee_1');
    expect(email.calls[0].data).toEqual({ type: 'instruction', instructionId: 'instr_1' });
    expect(prisma.instructions[0].lastReminderAt).toEqual(NOW);
  });

  it('does not fire for an instruction reminded less than 2 days ago', async () => {
    const email = new RecordingChannel('email');
    const { prisma, service } = buildService([email]);
    prisma.instructions.push({
      id: 'instr_2',
      assigneeId: 'mentee_2',
      title: 'Fill in your goals',
      status: 'PENDING',
      lastReminderAt: new Date(NOW.getTime() - days(1)),
    });

    jest.useFakeTimers().setSystemTime(NOW);
    await service.runDailySweep();

    expect(email.calls).toHaveLength(0);
    expect(prisma.instructions[0].lastReminderAt).toEqual(new Date(NOW.getTime() - days(1)));
  });
});

describe('ReminderDispatchService.dispatchToUser', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns false and does not throw when there are no channels configured', async () => {
    const { service } = buildService([]);

    const succeeded = await service.dispatchToUser('user_1', {
      title: 'Title',
      body: 'Body',
      data: { type: 'instruction', instructionId: 'instr_x' },
      notificationType: 'INSTRUCTION_ASSIGNED' as any,
    });

    expect(succeeded).toBe(false);
  });
});
