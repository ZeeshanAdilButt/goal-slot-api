import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JiffyConversation } from '../jiffy-messaging.client';
import { MessagingConfigService } from '../messaging-config.service';
import { MessagingService } from '../messaging.service';
import { MessagingTokenService } from '../messaging-token.service';

const ME = 'user_me';
const FRIEND = 'user_friend';
const STRANGER = 'user_stranger';

const CONFIGURED_ENV = {
  JIFFY_MESSAGING_URL: 'https://messaging.example.com',
  JIFFY_MESSAGING_JWT_SECRET: 'shared-secret',
};

interface ShareRow {
  id: string;
  ownerId: string;
  sharedWithId: string | null;
  isAccepted: boolean;
}

class FakePrisma {
  users = new Map<string, any>();
  shares: ShareRow[] = [];
  userLookups: string[] = [];
  shareQueries = 0;

  user = {
    findUnique: async ({ where }: any) => {
      this.userLookups.push(where.id);
      return this.users.get(where.id) ?? null;
    },
  };

  sharedAccess = {
    findFirst: async ({ where }: any) => {
      this.shareQueries++;
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

  addUser(id: string, name = id) {
    this.users.set(id, {
      id,
      name,
      email: `${id}@example.com`,
      avatar: null,
    });
  }

  addShare(ownerId: string, sharedWithId: string | null, isAccepted: boolean) {
    this.shares.push({
      id: `share_${this.shares.length + 1}`,
      ownerId,
      sharedWithId,
      isAccepted,
    });
  }
}

class FakeJiffyClient {
  conversations: JiffyConversation[] = [];
  createdWith: string[][] = [];
  listCalls = 0;
  tokensSeen: string[] = [];

  async listConversations(token: string): Promise<JiffyConversation[]> {
    this.listCalls++;
    this.tokensSeen.push(token);
    return this.conversations;
  }

  async createConversation(
    token: string,
    participantIds: string[],
  ): Promise<JiffyConversation> {
    this.tokensSeen.push(token);
    this.createdWith.push(participantIds);

    const conversation: JiffyConversation = {
      id: `conv_${this.createdWith.length}`,
      participants: participantIds.map((userId) => ({
        userId,
        lastReadAt: null,
      })),
      createdAt: '2026-08-12T00:00:00.000Z',
    };

    this.conversations.push(conversation);
    return conversation;
  }

  seed(id: string, participantIds: string[]) {
    this.conversations.push({
      id,
      participants: participantIds.map((userId) => ({
        userId,
        lastReadAt: null,
      })),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }
}

class FakeReminderDispatch {
  calls: Array<{ userId: string; content: any }> = [];

  async dispatchToUser(userId: string, content: any): Promise<boolean> {
    this.calls.push({ userId, content });
    return true;
  }
}

function buildService(env: Record<string, unknown> = CONFIGURED_ENV) {
  const prisma = new FakePrisma();
  const config = new MessagingConfigService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
  const jiffy = new FakeJiffyClient();
  const reminderDispatch = new FakeReminderDispatch();

  const service = new MessagingService(
    prisma as any,
    config,
    new MessagingTokenService(config),
    jiffy as any,
    reminderDispatch as any,
  );

  return { prisma, jiffy, reminderDispatch, service };
}

describe('MessagingService permission rule', () => {
  it('allows messaging someone I share my reports with', async () => {
    const { prisma, service, jiffy } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);

    const result = await service.openConversation(ME, FRIEND);

    expect(await service.canMessage(ME, FRIEND)).toBe(true);
    expect(result.created).toBe(true);
    expect(jiffy.createdWith).toEqual([[ME, FRIEND]]);
  });

  it('allows messaging someone who shares their reports with me', async () => {
    const { prisma, service } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(FRIEND, ME, true);

    await expect(service.openConversation(ME, FRIEND)).resolves.toMatchObject({
      created: true,
    });
  });

  it('rejects a stranger with 403', async () => {
    const { prisma, service, jiffy } = buildService();
    prisma.addUser(STRANGER);

    await expect(service.openConversation(ME, STRANGER)).rejects.toThrow(
      ForbiddenException,
    );
    expect(await service.canMessage(ME, STRANGER)).toBe(false);
    expect(jiffy.createdWith).toEqual([]);
    expect(jiffy.listCalls).toBe(0);
  });

  it('rejects a share that has only been invited, not accepted', async () => {
    const { prisma, service } = buildService();
    prisma.addUser(STRANGER);
    prisma.addShare(ME, STRANGER, false);

    await expect(service.openConversation(ME, STRANGER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('does not let a public link open an inbox', async () => {
    const { prisma, service } = buildService();
    prisma.addUser(STRANGER);
    // Public links are stored with no sharedWithId and are never accepted.
    prisma.addShare(STRANGER, null, false);

    await expect(service.openConversation(ME, STRANGER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a share between two other people', async () => {
    const { prisma, service } = buildService();
    prisma.addUser(STRANGER);
    prisma.addShare(FRIEND, STRANGER, true);

    await expect(service.openConversation(ME, STRANGER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a conversation with yourself', async () => {
    const { prisma, service } = buildService();
    prisma.addUser(ME);

    await expect(service.openConversation(ME, ME)).rejects.toThrow(
      BadRequestException,
    );
    expect(await service.canMessage(ME, ME)).toBe(false);
  });

  it('404s on a user that does not exist', async () => {
    const { service } = buildService();

    await expect(service.openConversation(ME, 'nobody')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('MessagingService conversation handling', () => {
  it('reuses the existing one-to-one conversation', async () => {
    const { prisma, service, jiffy } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);
    jiffy.seed('conv_existing', [ME, FRIEND]);

    const result = await service.openConversation(ME, FRIEND);

    expect(result.conversationId).toBe('conv_existing');
    expect(result.created).toBe(false);
    expect(jiffy.createdWith).toEqual([]);
  });

  it('is stable across repeated calls', async () => {
    const { prisma, service } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);

    const first = await service.openConversation(ME, FRIEND);
    const second = await service.openConversation(ME, FRIEND);

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.created).toBe(false);
  });

  it('does not mistake a group conversation for the pair', async () => {
    const { prisma, service, jiffy } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);
    jiffy.seed('conv_group', [ME, FRIEND, STRANGER]);

    const result = await service.openConversation(ME, FRIEND);

    expect(result.conversationId).not.toBe('conv_group');
    expect(result.created).toBe(true);
  });

  it('ignores my conversation with somebody else', async () => {
    const { prisma, service, jiffy } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);
    jiffy.seed('conv_other', [ME, STRANGER]);

    const result = await service.openConversation(ME, FRIEND);

    expect(result.conversationId).not.toBe('conv_other');
    expect(result.created).toBe(true);
    expect([...result.participantIds].sort()).toEqual([FRIEND, ME].sort());
  });

  it('returns the counterpart so a client can render the thread header', async () => {
    const { prisma, service } = buildService();
    prisma.addUser(FRIEND, 'Friendly Person');
    prisma.addShare(ME, FRIEND, true);

    const result = await service.openConversation(ME, FRIEND);

    expect(result.counterpart).toEqual({
      id: FRIEND,
      name: 'Friendly Person',
      email: `${FRIEND}@example.com`,
      avatar: null,
    });
  });

  it('calls the service with a token minted for the acting user', async () => {
    const { prisma, service, jiffy } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);

    await service.openConversation(ME, FRIEND);

    expect(jiffy.tokensSeen.length).toBeGreaterThan(0);
    for (const token of jiffy.tokensSeen) {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      );
      expect(payload.sub).toBe(ME);
    }
  });

  it('surfaces an unreachable messaging service as 503', async () => {
    const { prisma, service, jiffy } = buildService();
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);
    jiffy.listConversations = async () => {
      throw new ServiceUnavailableException(
        'The messaging service is unreachable',
      );
    };

    await expect(service.openConversation(ME, FRIEND)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('MessagingService when messaging is not configured', () => {
  it('answers 503 on token issue', async () => {
    const { service } = buildService({});

    await expect(service.issueToken(ME)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('answers 503 on open conversation without touching the database', async () => {
    const { prisma, service, jiffy } = buildService({});
    prisma.addUser(FRIEND);
    prisma.addShare(ME, FRIEND, true);

    await expect(service.openConversation(ME, FRIEND)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.userLookups).toEqual([]);
    expect(prisma.shareQueries).toBe(0);
    expect(jiffy.listCalls).toBe(0);
  });
});

describe('MessagingService.issueToken', () => {
  it('returns a refreshable token alongside the service URL', async () => {
    const { service } = buildService();

    const result = await service.issueToken(ME);

    expect(result.userId).toBe(ME);
    expect(result.messagingUrl).toBe('https://messaging.example.com');
    expect(result.expiresIn).toBe(900);
    expect(result.token.split('.')).toHaveLength(3);
  });
});

describe('MessagingService.notifyMessageSent', () => {
  it('dispatches to every recipient with the sender name as the title', async () => {
    const { prisma, reminderDispatch, service } = buildService();
    prisma.addUser(ME, 'Priya');

    await service.notifyMessageSent({
      messageId: 'msg_1',
      conversationId: 'conv_1',
      senderId: ME,
      recipientIds: [FRIEND, STRANGER],
      body: 'hi there',
      createdAt: '2026-08-14T00:00:00.000Z',
    });

    expect(reminderDispatch.calls.map((c) => c.userId)).toEqual([
      FRIEND,
      STRANGER,
    ]);
    expect(reminderDispatch.calls[0].content).toMatchObject({
      title: 'Priya',
      body: 'hi there',
      data: { type: 'conversation', conversationId: 'conv_1' },
      notificationType: 'MESSAGE_RECEIVED',
    });
  });

  it('falls back to the sender email, then "Someone", when no name is on file', async () => {
    const { prisma, reminderDispatch, service } = buildService();
    prisma.users.set(ME, { id: ME, name: null, email: 'priya@example.com' });

    await service.notifyMessageSent({
      messageId: 'msg_1',
      conversationId: 'conv_1',
      senderId: ME,
      recipientIds: [FRIEND],
      body: 'hi',
      createdAt: '2026-08-14T00:00:00.000Z',
    });
    expect(reminderDispatch.calls[0].content.title).toBe('priya@example.com');

    prisma.users.delete(ME);
    await service.notifyMessageSent({
      messageId: 'msg_2',
      conversationId: 'conv_1',
      senderId: ME,
      recipientIds: [FRIEND],
      body: 'hi again',
      createdAt: '2026-08-14T00:00:00.000Z',
    });
    expect(reminderDispatch.calls[1].content.title).toBe('Someone');
  });

  it('truncates a long body to a preview', async () => {
    const { prisma, reminderDispatch, service } = buildService();
    prisma.addUser(ME);
    const longBody = 'x'.repeat(200);

    await service.notifyMessageSent({
      messageId: 'msg_1',
      conversationId: 'conv_1',
      senderId: ME,
      recipientIds: [FRIEND],
      body: longBody,
      createdAt: '2026-08-14T00:00:00.000Z',
    });

    const preview = reminderDispatch.calls[0].content.body as string;
    expect(preview.length).toBe(143); // 140 chars + '...'
    expect(preview.endsWith('...')).toBe(true);
  });

  it('does not let one recipient failing stop the others', async () => {
    const { prisma, reminderDispatch, service } = buildService();
    prisma.addUser(ME);
    reminderDispatch.dispatchToUser = async (userId: string) => {
      if (userId === FRIEND) throw new Error('push provider down');
      return true;
    };

    await expect(
      service.notifyMessageSent({
        messageId: 'msg_1',
        conversationId: 'conv_1',
        senderId: ME,
        recipientIds: [FRIEND, STRANGER],
        body: 'hi',
        createdAt: '2026-08-14T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
  });
});
