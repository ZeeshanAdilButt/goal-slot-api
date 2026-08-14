import { ConfigService } from '@nestjs/config';

import { JiffyMessagingClient } from '../jiffy-messaging.client';
import { InternalMessagingController } from '../internal-messaging.controller';
import { MessagingConfigService } from '../messaging-config.service';
import { MessagingService } from '../messaging.service';
import { MessagingTokenService } from '../messaging-token.service';
import { ReminderDispatchService } from '../../reminders/reminder-dispatch.service';

const ME = 'user_me';
const FRIEND = 'user_friend';
const STRANGER = 'user_stranger';

interface ShareRow {
  id: string;
  ownerId: string;
  sharedWithId: string | null;
  isAccepted: boolean;
}

// Same shape as messaging.service.spec.ts's FakePrisma, trimmed to just
// what canCreateConversation/canMessage query - this file exists to prove
// the internal endpoint mirrors canMessage's own decisions, not to
// re-test canMessage's query shape a second time.
class FakePrisma {
  shares: ShareRow[] = [];

  sharedAccess = {
    findFirst: async ({ where }: any) => {
      const clauses: Array<{ ownerId: string; sharedWithId: string }> =
        where.OR;

      const match = this.shares.find(
        (share) =>
          share.isAccepted === where.isAccepted &&
          clauses.some(
            (clause) =>
              share.ownerId === clause.ownerId &&
              share.sharedWithId === clause.sharedWithId,
          ),
      );

      return match ? { id: match.id } : null;
    },
  };

  addShare(ownerId: string, sharedWithId: string | null, isAccepted: boolean) {
    this.shares.push({
      id: `share_${this.shares.length + 1}`,
      ownerId,
      sharedWithId,
      isAccepted,
    });
  }
}

function buildController() {
  const prisma = new FakePrisma();
  const config = new MessagingConfigService({
    get: (key: string) =>
      (
        ({ CONVERSATION_GATE_SECRET: 'shared-secret' }) as Record<
          string,
          unknown
        >
      )[key],
  } as unknown as ConfigService);
  const tokens = new MessagingTokenService(config);
  // Unused by canCreateConversation - never mints a token or calls out to
  // jiffy-messaging, unlike openConversation.
  const jiffy = {} as JiffyMessagingClient;
  // Unused by canCreateConversation - only notifyMessageSent (backing the
  // separate on-message-sent route) touches this.
  const reminderDispatch = {} as ReminderDispatchService;

  const service = new MessagingService(
    prisma as any,
    config,
    tokens,
    jiffy,
    reminderDispatch,
  );
  const controller = new InternalMessagingController(service);

  return { prisma, controller };
}

describe('InternalMessagingController.canCreateConversation mirrors canMessage', () => {
  it('rejects a stranger', async () => {
    const { controller } = buildController();

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME, STRANGER],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('rejects a share that has only been invited, not accepted', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(ME, STRANGER, false);

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME, STRANGER],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('does not let a public link open an inbox', async () => {
    const { prisma, controller } = buildController();
    // Public links are stored with no sharedWithId and are never accepted.
    prisma.addShare(STRANGER, null, false);

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME, STRANGER],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('allows an accepted share the requester owns', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(ME, FRIEND, true);

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME, FRIEND],
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it('allows an accepted share the counterpart owns (the other direction)', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(FRIEND, ME, true);

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME, FRIEND],
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it('rejects a share between two other people', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(FRIEND, STRANGER, true);

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME, STRANGER],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('rejects when requesterId is not among participantIds', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(ME, FRIEND, true);

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [FRIEND, STRANGER],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('rejects a group-shaped participant list, even with an accepted share to one of them', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(ME, FRIEND, true);

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME, FRIEND, STRANGER],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('rejects a lone requester with no counterpart', async () => {
    const { controller } = buildController();

    await expect(
      controller.canCreateConversation({
        requesterId: ME,
        participantIds: [ME],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('this is exactly the request jiffy-messaging would send for the attack in the bug report: attacker mints a self-service token, then calls jiffy-messaging directly with a victim they only know the id of', async () => {
    const { controller } = buildController();
    const attacker = ME;
    const victim = STRANGER;
    // No share of any kind exists between attacker and victim - the
    // victim's id was learned from an invite response, not consent.

    await expect(
      controller.canCreateConversation({
        requesterId: attacker,
        participantIds: [attacker, victim],
      }),
    ).resolves.toEqual({ allowed: false });
  });
});

describe('InternalMessagingController.onMessageSent', () => {
  it('dispatches to every recipient and returns { ok: true }', async () => {
    const prisma = {
      user: {
        findUnique: async () => ({ name: 'Priya', email: 'priya@example.com' }),
      },
    };
    const config = new MessagingConfigService({
      get: () => undefined,
    } as unknown as ConfigService);
    const tokens = new MessagingTokenService(config);
    const jiffy = {} as JiffyMessagingClient;
    const calls: Array<{ userId: string; content: any }> = [];
    const reminderDispatch = {
      dispatchToUser: async (userId: string, content: any) => {
        calls.push({ userId, content });
        return true;
      },
    };

    const service = new MessagingService(
      prisma as any,
      config,
      tokens,
      jiffy,
      reminderDispatch as any,
    );
    const controller = new InternalMessagingController(service);

    await expect(
      controller.onMessageSent({
        messageId: 'msg_1',
        conversationId: 'conv_1',
        senderId: ME,
        recipientIds: [FRIEND, STRANGER],
        body: 'hi there',
        createdAt: '2026-08-14T00:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: true });

    expect(calls.map((c) => c.userId)).toEqual([FRIEND, STRANGER]);
    expect(calls[0].content).toMatchObject({
      title: 'Priya',
      body: 'hi there',
      data: { type: 'conversation', conversationId: 'conv_1' },
    });
  });
});
