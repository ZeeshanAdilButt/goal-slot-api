import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '@prisma/client';

interface ListNotificationsParams {
  userId: string;
  cursor?: string;
  limit?: number;
}

interface CreateFeedbackReplyNotificationInput {
  userId: string;
  feedbackId: string;
  responseId: string;
  message: string;
}

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async createFeedbackReplyNotification(input: CreateFeedbackReplyNotificationInput) {
    const preview = input.message.slice(0, 140);
    return this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: NotificationType.FEEDBACK_REPLY,
        title: 'New reply to your feedback',
        body: preview,
        data: {
          feedbackId: input.feedbackId,
          responseId: input.responseId,
        },
      },
    });
  }

  async list(params: ListNotificationsParams) {
    const take = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const items = await this.prisma.notification.findMany({
      where: { userId: params.userId },
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
    const nextCursor = hasMore ? items[take].id : undefined;
    const unreadCount = await this.prisma.notification.count({ where: { userId: params.userId, readAt: null } });

    return {
      items: sliced,
      nextCursor,
      hasMore,
      unreadCount,
    };
  }

  async markRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id } });
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
}
