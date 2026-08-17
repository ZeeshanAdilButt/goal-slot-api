import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType, Prisma } from '@prisma/client';
import {
  DEFAULT_NOTIFICATION_SCOPE,
  NotificationScope,
  notificationScopeFilter,
} from './notification-scope';

interface ListNotificationsParams {
  userId: string;
  cursor?: string;
  limit?: number;
  scope?: NotificationScope;
}

interface CreateFeedbackReplyNotificationInput {
  userId: string;
  feedbackId: string;
  responseId: string;
  message: string;
}

export interface MarkAllReadResult {
  /** Rows this call actually flipped from unread to read. */
  updated: number;
  /** Echo of the scope that was applied, so a client can assert it got what it asked for. */
  scope: NotificationScope;
  /** Unread remaining *within that scope*. Always 0 — see markAllRead. */
  unreadCount: number;
}

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async createFeedbackReplyNotification(
    input: CreateFeedbackReplyNotificationInput,
  ) {
    const preview = input.message.slice(0, 140);
    return this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: NotificationType.FEEDBACK_REPLY,
        title: 'New reply to your feedback',
        body: preview,
        data: {
          // Every other notification payload carries a `type` discriminant
          // (`conversation`, `schedule`, `instruction`, `release`), and the
          // clients' tap resolvers switch on it — a payload without one is
          // rejected outright, which is why tapping a feedback reply on
          // mobile did nothing at all. Web only appeared to work because it
          // special-cased the NotificationType enum instead of reading the
          // payload. This is the missing discriminant.
          type: 'feedback',
          feedbackId: input.feedbackId,
          responseId: input.responseId,
        },
      },
    });
  }

  /**
   * The `where` every scoped read/write shares. Ownership lives in this one
   * place: `userId` is part of the predicate itself, so a scoped query can
   * never touch another user's rows regardless of what else is spread in.
   */
  private scopedWhere(
    userId: string,
    scope: NotificationScope,
  ): Prisma.NotificationWhereInput {
    return { userId, ...notificationScopeFilter(scope) };
  }

  async list(params: ListNotificationsParams) {
    const scope = params.scope ?? DEFAULT_NOTIFICATION_SCOPE;
    const take = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const where = this.scopedWhere(params.userId, scope);

    const items = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor
        ? {
            cursor: { id: params.cursor },
            skip: 1,
          }
        : {}),
    });

    const hasMore = items.length > take;
    const sliced = hasMore ? items.slice(0, take) : items;
    // The cursor is the LAST row we returned, because the follow-up query
    // seeks to the cursor and then `skip: 1`s past it. This used to be
    // `items[take].id` — the first row we did *not* return — which the
    // next page's `skip: 1` then stepped over, silently dropping exactly
    // one notification at every page boundary.
    const nextCursor = hasMore ? sliced[sliced.length - 1].id : undefined;
    // Deliberately the SAME `where` as the findMany above, plus unread.
    // If this count is ever allowed to drift wider than the list, the bell
    // shows a badge over rows that are not there and cannot be cleared.
    const unreadCount = await this.prisma.notification.count({
      where: { ...where, readAt: null },
    });

    return {
      items: sliced,
      nextCursor,
      hasMore,
      unreadCount,
      scope,
    };
  }

  async markRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    if (notification.userId !== userId) {
      throw new ForbiddenException('You cannot update this notification');
    }

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  /**
   * Mark every unread notification in `scope` as read, for this user only.
   *
   * ONE statement — a single `UPDATE ... WHERE "userId" = $1 AND "readAt"
   * IS NULL [AND "type" NOT IN (...)]`. Never a read-then-loop: this has to
   * stay cheap, and the per-row `markRead` above already costs two round
   * trips for one row.
   *
   * Ownership is enforced by the predicate rather than by a fetch-then-check,
   * so there is no window and no branch to get wrong: rows belonging to any
   * other user are not selected by the UPDATE in the first place. Both the
   * `(userId, readAt)` index (Notification_userId_readAt_idx) backs this.
   *
   * `unreadCount` is 0 by construction — this call just cleared every unread
   * row in `scope`, so re-counting the same predicate would cost a query to
   * learn a value we already know. It is returned anyway so a client can set
   * its badge straight off the mutation response without a follow-up read.
   */
  async markAllRead(
    userId: string,
    scope: NotificationScope = DEFAULT_NOTIFICATION_SCOPE,
  ): Promise<MarkAllReadResult> {
    const { count } = await this.prisma.notification.updateMany({
      where: { ...this.scopedWhere(userId, scope), readAt: null },
      data: { readAt: new Date() },
    });

    return { updated: count, scope, unreadCount: 0 };
  }
}
