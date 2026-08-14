// This suite exercises the seam item 6 of the notifications audit called
// out as untested: MessagingService.notifyMessageSent -> real
// ReminderDispatchService.dispatchToUser -> a real channel, with `data`
// carrying an actual conversationId rather than a mock/stub value.
// messaging.service.spec.ts already covers MessagingService in isolation
// with a fake ReminderDispatchService, and reminder-dispatch.service.spec.ts
// covers ReminderDispatchService in isolation with fake channels - neither
// wires the real thing end to end.
const isExpoPushToken = jest.fn();
const chunkPushNotifications = jest.fn();
const sendPushNotificationsAsync = jest.fn();

jest.mock('expo-server-sdk', () => ({
  Expo: Object.assign(
    jest.fn().mockImplementation(() => ({
      chunkPushNotifications,
      sendPushNotificationsAsync,
    })),
    { isExpoPushToken },
  ),
}));

import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';

import { ExpoPushReminderChannel } from '../../reminders/channels/expo-push-channel.provider';
import {
  ReminderChannel,
  ReminderChannelInput,
  ReminderChannelKind,
  ReminderChannelResult,
} from '../../reminders/reminder-channel.interface';
import { ReminderDispatchService } from '../../reminders/reminder-dispatch.service';
import { MessagingConfigService } from '../messaging-config.service';
import { MessagingService } from '../messaging.service';
import { MessagingTokenService } from '../messaging-token.service';

class RecordingEmailChannel implements ReminderChannel {
  readonly name = 'email';
  readonly kind: ReminderChannelKind = 'email';
  calls: ReminderChannelInput[] = [];

  async send(input: ReminderChannelInput): Promise<ReminderChannelResult> {
    this.calls.push(input);
    return { ok: true };
  }
}

class FakePrisma {
  users = new Map<string, any>();
  notifications: any[] = [];
  pushSubscriptions: any[] = [];

  user = {
    findUnique: async ({ where }: any) => this.users.get(where.id) ?? null,
  };

  notification = {
    create: async ({ data }: any) => {
      const row = { id: `notif_${this.notifications.length + 1}`, ...data };
      this.notifications.push(row);
      return row;
    },
  };

  pushSubscription = {
    findMany: async ({ where }: any) =>
      this.pushSubscriptions.filter(
        (s) => s.userId === where.userId && s.kind === where.kind,
      ),
    delete: async () => ({}),
  };
}

describe('MessagingService.notifyMessageSent -> ReminderDispatchService (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chunkPushNotifications.mockImplementation((messages: any[]) => [messages]);
    isExpoPushToken.mockReturnValue(true);
  });

  it('carries a real conversationId through to the Expo push call and the in-app notification, and suppresses email per policy', async () => {
    const prisma = new FakePrisma();
    prisma.users.set('sender_1', {
      name: 'Priya',
      email: 'priya@example.com',
    });
    prisma.pushSubscriptions.push({
      id: 'sub_1',
      userId: 'recipient_1',
      kind: 'EXPO',
      expoToken: 'ExponentPushToken[real]',
    });
    sendPushNotificationsAsync.mockResolvedValue([
      { status: 'ok', id: 'receipt-1' },
    ]);

    const expoPush = new ExpoPushReminderChannel(prisma as any);
    const email = new RecordingEmailChannel();
    const reminderDispatch = new ReminderDispatchService(prisma as any, [
      email,
      expoPush,
    ]);

    const config = new MessagingConfigService({
      get: () => undefined,
    } as unknown as ConfigService);
    const messagingService = new MessagingService(
      prisma as any,
      config,
      new MessagingTokenService(config),
      {} as any, // JiffyMessagingClient - notifyMessageSent never calls it
      reminderDispatch,
    );

    await messagingService.notifyMessageSent({
      messageId: 'msg_1',
      conversationId: 'conv_real_1',
      senderId: 'sender_1',
      recipientIds: ['recipient_1'],
      body: 'hey, are we still on for tomorrow?',
      createdAt: '2026-08-14T00:00:00.000Z',
    });

    // MESSAGE_RECEIVED is push-only (NOTIFICATION_POLICY) - email must
    // never be attempted, not just fail silently.
    expect(email.calls).toHaveLength(0);

    // The real conversationId set on the DTO above reaches the real Expo
    // SDK call, along with the high-priority/sound/channelId presentation
    // MESSAGE_RECEIVED gets - none of this is a mocked or stubbed value.
    expect(sendPushNotificationsAsync).toHaveBeenCalledWith([
      {
        to: 'ExponentPushToken[real]',
        title: 'Priya',
        body: 'hey, are we still on for tomorrow?',
        data: { type: 'conversation', conversationId: 'conv_real_1' },
        sound: 'default',
        channelId: 'goalslot-schedule-notify-v1',
        priority: 'high',
      },
    ]);

    // The in-app Notification row carries the same real conversationId.
    expect(prisma.notifications[0]).toMatchObject({
      userId: 'recipient_1',
      type: NotificationType.MESSAGE_RECEIVED,
      data: { type: 'conversation', conversationId: 'conv_real_1' },
    });
  });

  it('does not notify at all when the recipient has no push subscription and email is suppressed', async () => {
    const prisma = new FakePrisma();
    prisma.users.set('sender_1', { name: 'Priya', email: 'p@example.com' });
    // No pushSubscriptions seeded for the recipient.

    const expoPush = new ExpoPushReminderChannel(prisma as any);
    const email = new RecordingEmailChannel();
    const reminderDispatch = new ReminderDispatchService(prisma as any, [
      email,
      expoPush,
    ]);
    const config = new MessagingConfigService({
      get: () => undefined,
    } as unknown as ConfigService);
    const messagingService = new MessagingService(
      prisma as any,
      config,
      new MessagingTokenService(config),
      {} as any,
      reminderDispatch,
    );

    await messagingService.notifyMessageSent({
      messageId: 'msg_2',
      conversationId: 'conv_real_2',
      senderId: 'sender_1',
      recipientIds: ['recipient_2'],
      body: 'hi',
      createdAt: '2026-08-14T00:00:00.000Z',
    });

    expect(email.calls).toHaveLength(0);
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
    // The in-app row still gets created even though no external channel
    // could reach this recipient.
    expect(prisma.notifications).toHaveLength(1);
  });
});
