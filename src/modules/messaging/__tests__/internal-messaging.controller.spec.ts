import { ConfigService } from '@nestjs/config';

import { JiffyMessagingClient } from '../jiffy-messaging.client';
import { InternalMessagingController } from '../internal-messaging.controller';
import { MessagingConfigService } from '../messaging-config.service';
import { MessagingService } from '../messaging.service';
import { MessagingTokenService } from '../messaging-token.service';

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
      const clauses: Array<{ ownerId: string; sharedWithId: string }> = where.OR;

      const match = this.shares.find(
        (share) =>
          share.isAccepted === where.isAccepted &&
          clauses.some(
            (clause) =>
              share.ownerId === clause.ownerId && share.sharedWithId === clause.sharedWithId,
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
    get: (key: string) => ({ CONVERSATION_GATE_SECRET: 'shared-secret' } as Record<string, unknown>)[key],
  } as unknown as ConfigService);
  const tokens = new MessagingTokenService(config);
  // Unused by canCreateConversation - never mints a token or calls out to
  // jiffy-messaging, unlike openConversation.
  const jiffy = {} as JiffyMessagingClient;

  const service = new MessagingService(prisma as any, config, tokens, jiffy);
  const controller = new InternalMessagingController(service);

  return { prisma, controller };
}

describe('InternalMessagingController.canCreateConversation mirrors canMessage', () => {
  it('rejects a stranger', async () => {
    const { controller } = buildController();

    await expect(
      controller.canCreateConversation({ requesterId: ME, participantIds: [ME, STRANGER] }),
    ).resolves.toEqual({ allowed: false });
  });

  it('rejects a share that has only been invited, not accepted', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(ME, STRANGER, false);

    await expect(
      controller.canCreateConversation({ requesterId: ME, participantIds: [ME, STRANGER] }),
    ).resolves.toEqual({ allowed: false });
  });

  it('does not let a public link open an inbox', async () => {
    const { prisma, controller } = buildController();
    // Public links are stored with no sharedWithId and are never accepted.
    prisma.addShare(STRANGER, null, false);

    await expect(
      controller.canCreateConversation({ requesterId: ME, participantIds: [ME, STRANGER] }),
    ).resolves.toEqual({ allowed: false });
  });

  it('allows an accepted share the requester owns', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(ME, FRIEND, true);

    await expect(
      controller.canCreateConversation({ requesterId: ME, participantIds: [ME, FRIEND] }),
    ).resolves.toEqual({ allowed: true });
  });

  it('allows an accepted share the counterpart owns (the other direction)', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(FRIEND, ME, true);

    await expect(
      controller.canCreateConversation({ requesterId: ME, participantIds: [ME, FRIEND] }),
    ).resolves.toEqual({ allowed: true });
  });

  it('rejects a share between two other people', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(FRIEND, STRANGER, true);

    await expect(
      controller.canCreateConversation({ requesterId: ME, participantIds: [ME, STRANGER] }),
    ).resolves.toEqual({ allowed: false });
  });

  it('rejects when requesterId is not among participantIds', async () => {
    const { prisma, controller } = buildController();
    prisma.addShare(ME, FRIEND, true);

    await expect(
      controller.canCreateConversation({ requesterId: ME, participantIds: [FRIEND, STRANGER] }),
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
      controller.canCreateConversation({ requesterId: ME, participantIds: [ME] }),
    ).resolves.toEqual({ allowed: false });
  });

  it('this is exactly the request jiffy-messaging would send for the attack in the bug report: attacker mints a self-service token, then calls jiffy-messaging directly with a victim they only know the id of', async () => {
    const { controller } = buildController();
    const attacker = ME;
    const victim = STRANGER;
    // No share of any kind exists between attacker and victim - the
    // victim's id was learned from an invite response, not consent.

    await expect(
      controller.canCreateConversation({ requesterId: attacker, participantIds: [attacker, victim] }),
    ).resolves.toEqual({ allowed: false });
  });
});
