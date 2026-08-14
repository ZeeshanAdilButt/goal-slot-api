import { ReminderDispatchService } from './reminder-dispatch.service';
import {
  ReminderChannel,
  ReminderChannelInput,
  ReminderChannelKind,
  ReminderChannelResult,
} from './reminder-channel.interface';

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
  readonly kind: ReminderChannelKind;

  constructor(
    public readonly name: string,
    private readonly result: ReminderChannelResult = { ok: true },
    private readonly shouldReject = false,
    kind?: ReminderChannelKind,
  ) {
    // Every existing call site below constructs 'email', 'expo-push', or
    // 'web-push' - inferring kind from name keeps them all unchanged, while
    // still letting tests that care about channel-kind filtering pass one
    // explicitly (see the notification-policy describe block).
    this.kind = kind ?? (name === 'email' ? 'email' : 'push');
  }

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
    expect(email.calls[0].data).toEqual({
      type: 'schedule',
      sharedAccessId: 'share_1',
    });
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
    expect(email.calls[0].data).toEqual({
      type: 'instruction',
      instructionId: 'instr_1',
    });
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
    expect(prisma.instructions[0].lastReminderAt).toEqual(
      new Date(NOW.getTime() - days(1)),
    );
  });
});

describe('ReminderDispatchService.sendInstructionReminder', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('dispatches to every channel with the same content the sweep uses and stamps lastReminderAt', async () => {
    const email = new RecordingChannel('email');
    const expoPush = new RecordingChannel('expo-push');
    const webPush = new RecordingChannel('web-push');
    const { prisma, service } = buildService([email, expoPush, webPush]);
    prisma.instructions.push({
      id: 'instr_5',
      assigneeId: 'mentee_5',
      title: 'Start tracking your time again',
      status: 'PENDING',
      lastReminderAt: null,
    });

    const succeeded = await service.sendInstructionReminder(
      {
        id: 'instr_5',
        assigneeId: 'mentee_5',
        title: 'Start tracking your time again',
      },
      NOW,
    );

    expect(succeeded).toBe(true);
    for (const channel of [email, expoPush, webPush]) {
      expect(channel.calls).toHaveLength(1);
      expect(channel.calls[0].userId).toBe('mentee_5');
      expect(channel.calls[0].title).toContain(
        'Start tracking your time again',
      );
      expect(channel.calls[0].data).toEqual({
        type: 'instruction',
        instructionId: 'instr_5',
      });
    }
    expect(prisma.instructions[0].lastReminderAt).toEqual(NOW);
  });

  it('resolves false and does not throw when every channel fails, and leaves lastReminderAt untouched', async () => {
    const rejecting = new RecordingChannel('web-push', { ok: false }, true);
    const { prisma, service } = buildService([rejecting]);
    prisma.instructions.push({
      id: 'instr_6',
      assigneeId: 'mentee_6',
      title: 'Log your hours',
      status: 'PENDING',
      lastReminderAt: null,
    });

    const succeeded = await service.sendInstructionReminder(
      { id: 'instr_6', assigneeId: 'mentee_6', title: 'Log your hours' },
      NOW,
    );

    expect(succeeded).toBe(false);
    expect(prisma.instructions[0].lastReminderAt).toBeNull();
  });

  it('never throws even when the prisma update itself fails', async () => {
    const email = new RecordingChannel('email');
    const { service } = buildService([email]);
    // No matching row in prisma.instructions, so the update call inside
    // FakePrisma will operate on undefined and throw when merging fields -
    // sendInstructionReminder must still resolve rather than propagate.
    await expect(
      service.sendInstructionReminder(
        { id: 'does_not_exist', assigneeId: 'mentee_7', title: 'Ghost' },
        NOW,
      ),
    ).resolves.toBe(false);
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

describe('ReminderDispatchService.dispatchToUser - notification policy', () => {
  // MESSAGE_RECEIVED is push-only in NOTIFICATION_POLICY (see
  // notification-policy.ts) - a chat message shouldn't email the recipient
  // minutes to hours later. This is the behavior item 2 exists to add: a
  // suppressed channel must be filtered out before the fan-out, not
  // attempted and then ignored.
  it('does not attempt the email channel for a MESSAGE_RECEIVED notification', async () => {
    const email = new RecordingChannel('email');
    const push = new RecordingChannel('expo-push');
    const { service } = buildService([email, push]);

    const succeeded = await service.dispatchToUser('user_1', {
      title: 'Priya',
      body: 'hi there',
      data: { type: 'conversation', conversationId: 'conv_1' },
      notificationType: 'MESSAGE_RECEIVED' as any,
    });

    expect(succeeded).toBe(true);
    expect(email.calls).toHaveLength(0);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].notificationType).toBe('MESSAGE_RECEIVED');
  });

  // SHARED_REPORT_UNVIEWED and INSTRUCTION_ASSIGNED are daily/cron-driven
  // nudges - both channels are attempted since nothing is time-sensitive
  // about them.
  it.each(['SHARED_REPORT_UNVIEWED', 'INSTRUCTION_ASSIGNED'])(
    'attempts both email and push for a %s notification',
    async (notificationType) => {
      const email = new RecordingChannel('email');
      const push = new RecordingChannel('expo-push');
      const { service } = buildService([email, push]);

      await service.dispatchToUser('user_1', {
        title: 'Title',
        body: 'Body',
        data: {},
        notificationType: notificationType as any,
      });

      expect(email.calls).toHaveLength(1);
      expect(push.calls).toHaveLength(1);
    },
  );

  // FEEDBACK_REPLY never reaches dispatchToUser today (NotificationsService
  // writes the in-app row directly), but the policy table is exhaustive
  // over NotificationType, so if it ever did go through this path both
  // channels should stay suppressed rather than firing unexpectedly.
  it('attempts no channel for a FEEDBACK_REPLY notification', async () => {
    const email = new RecordingChannel('email');
    const push = new RecordingChannel('expo-push');
    const { service } = buildService([email, push]);

    const succeeded = await service.dispatchToUser('user_1', {
      title: 'New reply to your feedback',
      body: 'Body',
      data: {},
      notificationType: 'FEEDBACK_REPLY' as any,
    });

    expect(succeeded).toBe(false);
    expect(email.calls).toHaveLength(0);
    expect(push.calls).toHaveLength(0);
  });

  it('still creates the in-app notification even when every channel is suppressed', async () => {
    const email = new RecordingChannel('email');
    const { prisma, service } = buildService([email]);

    await service.dispatchToUser('user_1', {
      title: 'New reply to your feedback',
      body: 'Body',
      data: {},
      notificationType: 'FEEDBACK_REPLY' as any,
    });

    expect(prisma.notifications).toHaveLength(1);
    expect(email.calls).toHaveLength(0);
  });

  // A channel that happens to have both an email-kind and a push-kind
  // instance (e.g. web-push and expo-push, both 'push') both get attempted
  // together - the filter is by kind, not by name.
  it('attempts every push-kind channel, not just one, when push is allowed', async () => {
    const expoPush = new RecordingChannel('expo-push');
    const webPush = new RecordingChannel('web-push');
    const { service } = buildService([expoPush, webPush]);

    await service.dispatchToUser('user_1', {
      title: 'Priya',
      body: 'hi',
      data: { type: 'conversation', conversationId: 'conv_1' },
      notificationType: 'MESSAGE_RECEIVED' as any,
    });

    expect(expoPush.calls).toHaveLength(1);
    expect(webPush.calls).toHaveLength(1);
  });
});
