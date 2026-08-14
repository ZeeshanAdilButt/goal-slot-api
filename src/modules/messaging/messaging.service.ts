import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ReminderDispatchService } from '../reminders/reminder-dispatch.service';
import {
  JiffyConversation,
  JiffyMessagingClient,
} from './jiffy-messaging.client';
import { OnMessageSentDto } from './dto/messaging.dto';
import { MessagingConfigService } from './messaging-config.service';
import { MessagingTokenService } from './messaging-token.service';

export interface MessagingTokenResponse {
  token: string;
  expiresIn: number;
  expiresAt: string;
  userId: string;
  /** So a client learns the REST and WebSocket host from one call. */
  messagingUrl: string;
}

export interface OpenConversationResponse {
  conversationId: string;
  participantIds: string[];
  createdAt: string;
  /** false when an existing conversation was reused. */
  created: boolean;
  counterpart: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  };
}

function isExactlyThisPair(
  conversation: JiffyConversation,
  a: string,
  b: string,
): boolean {
  if (conversation.participants.length !== 2) return false;

  const ids = conversation.participants.map((p) => p.userId);
  return ids.includes(a) && ids.includes(b);
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: MessagingConfigService,
    private readonly tokens: MessagingTokenService,
    private readonly jiffy: JiffyMessagingClient,
    private readonly reminderDispatch: ReminderDispatchService,
  ) {}

  async issueToken(userId: string): Promise<MessagingTokenResponse> {
    const config = this.config.require();
    const minted = await this.tokens.mint(userId);

    return { ...minted, userId, messagingUrl: config.baseUrl };
  }

  /**
   * GoalSlot's rule for who is allowed to talk to whom. jiffy-messaging
   * holds no opinion on this — it only enforces that whoever acts on a
   * conversation is already a participant of it — so this check is the
   * whole gate, and it runs before the conversation is ever created.
   *
   * The rule: an accepted report share in either direction. If you share
   * your reports with someone, or they share theirs with you, you have a
   * real relationship and can message each other. Pending invites do not
   * count (isAccepted must be true), and neither do public links, which
   * are never accepted and carry no sharedWithId — otherwise publishing a
   * link would open your inbox to strangers.
   */
  async canMessage(userId: string, counterpartId: string): Promise<boolean> {
    if (userId === counterpartId) return false;

    const share = await this.prisma.sharedAccess.findFirst({
      where: {
        isAccepted: true,
        OR: [
          { ownerId: userId, sharedWithId: counterpartId },
          { ownerId: counterpartId, sharedWithId: userId },
        ],
      },
      select: { id: true },
    });

    return share !== null;
  }

  /**
   * Backs POST /internal/messaging/can-create-conversation — the
   * ConversationGate callback jiffy-messaging invokes before creating a
   * conversation, and again before every message send, so a relationship
   * revoked after a conversation was opened stops working on the next
   * send rather than lingering as a permanent back door.
   *
   * jiffy-messaging's gate contract is participantIds-shaped because it
   * has no idea a conversation here is ever anything but two people; this
   * translates that generic shape into the pairwise canMessage check
   * above. Anything that is not exactly requesterId plus one other id is
   * rejected outright — GoalSlot never creates a group conversation, so a
   * request shaped like one is already outside what this relationship
   * model has an opinion on, and the safe default for "outside the model"
   * is no.
   */
  async canCreateConversation(
    requesterId: string,
    participantIds: string[],
  ): Promise<boolean> {
    if (!participantIds.includes(requesterId)) return false;

    const others = [
      ...new Set(participantIds.filter((id) => id !== requesterId)),
    ];
    if (others.length !== 1) return false;

    return this.canMessage(requesterId, others[0]);
  }

  async openConversation(
    userId: string,
    counterpartId: string,
  ): Promise<OpenConversationResponse> {
    // Fail before any database work if the integration is switched off.
    this.config.require();

    if (userId === counterpartId) {
      throw new BadRequestException(
        'You cannot start a conversation with yourself',
      );
    }

    const counterpart = await this.prisma.user.findUnique({
      where: { id: counterpartId },
      select: { id: true, name: true, email: true, avatar: true },
    });

    if (!counterpart) {
      throw new NotFoundException('User not found');
    }

    if (!(await this.canMessage(userId, counterpartId))) {
      throw new ForbiddenException(
        'You can only message people you share reports with',
      );
    }

    const { token } = await this.tokens.mint(userId);

    // jiffy-messaging's POST /conversations always creates a new row — it
    // has no notion of "the" conversation between two people, because a
    // host app may legitimately want several. Deduplicating to one 1:1
    // thread is our policy, so we look first.
    //
    // Two simultaneous first-messages between the same pair can still
    // both miss and create two conversations. That is a rare, harmless
    // outcome (one thread looks empty) and the alternative — a lock or a
    // local mapping table — is not worth it until it actually bites.
    const existing = await this.jiffy.listConversations(token);
    const match = existing.find((conversation) =>
      isExactlyThisPair(conversation, userId, counterpartId),
    );

    if (match) {
      return this.toResponse(match, counterpart, false);
    }

    const created = await this.jiffy.createConversation(token, [
      userId,
      counterpartId,
    ]);

    return this.toResponse(created, counterpart, true);
  }

  /**
   * Backs POST /internal/messaging/on-message-sent — the MessageNotifier
   * callback jiffy-messaging invokes after a message is durably written,
   * so each recipient gets a push/email notification the same way an
   * instruction assignment or a stale-report reminder does (see
   * ReminderDispatchService, already built for exactly this "notify user
   * X across whatever channels they have" job).
   *
   * Every recipient is dispatched independently via allSettled: one
   * failing (a bad push token, an unreachable email provider) must not
   * stop the others, and the message itself already exists regardless —
   * there is nothing here to roll back.
   */
  async notifyMessageSent(dto: OnMessageSentDto): Promise<void> {
    const sender = await this.prisma.user.findUnique({
      where: { id: dto.senderId },
      select: { name: true, email: true },
    });
    const senderName = sender?.name?.trim() || sender?.email || 'Someone';

    // Long enough to read as a real preview, short enough that a push
    // notification's own OS-level truncation isn't doing all the work.
    const preview =
      dto.body.length > 140 ? `${dto.body.slice(0, 140)}...` : dto.body;

    const results = await Promise.allSettled(
      dto.recipientIds.map((recipientId) =>
        this.reminderDispatch.dispatchToUser(recipientId, {
          title: senderName,
          body: preview,
          data: { type: 'conversation', conversationId: dto.conversationId },
          notificationType: NotificationType.MESSAGE_RECEIVED,
        }),
      ),
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `Failed to notify recipient ${dto.recipientIds[index]} of message ${dto.messageId}: ${result.reason}`,
        );
      }
    });
  }

  private toResponse(
    conversation: JiffyConversation,
    counterpart: OpenConversationResponse['counterpart'],
    created: boolean,
  ): OpenConversationResponse {
    return {
      conversationId: conversation.id,
      participantIds: conversation.participants.map((p) => p.userId),
      createdAt: conversation.createdAt,
      created,
      counterpart,
    };
  }
}
