import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFeedbackDto, ArchiveFeedbackDto, ReplyFeedbackDto } from './dto/feedback.dto';
import { Prisma, UserRole } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class FeedbackService {
  constructor(private prisma: PrismaService, private notificationsService: NotificationsService) {}

  async create(userId: string, dto: CreateFeedbackDto) {
    return this.prisma.feedback.create({
      data: {
        userId,
        emoji: dto.emoji,
        text: dto.text,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findAll(filters: { isArchived?: boolean; userId?: string } = {}) {
    const where: Prisma.FeedbackWhereInput = {};

    if (filters.isArchived !== undefined) {
      where.isArchived = filters.isArchived;
    }

    if (filters.userId) {
      where.userId = filters.userId;
    }

    return this.prisma.feedback.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: string) {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });

    if (!feedback) {
      throw new NotFoundException('Feedback not found');
    }

    return feedback;
  }

  private assertCanAccessFeedback(feedback: any, userId: string, role: UserRole) {
    const isOwner = feedback.userId === userId;
    const isAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You are not allowed to access this feedback');
    }
    return { isOwner, isAdmin };
  }

  async getThread(feedbackId: string, userId: string, role: UserRole) {
    const feedback = await this.findOne(feedbackId);
    this.assertCanAccessFeedback(feedback, userId, role);

    const responses = await this.prisma.feedbackResponse.findMany({
      where: { feedbackId },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    });

    return { feedback, responses };
  }

  async addResponse(feedbackId: string, userId: string, role: UserRole, dto: ReplyFeedbackDto) {
    const feedback = await this.findOne(feedbackId);
    const { isAdmin } = this.assertCanAccessFeedback(feedback, userId, role);

    const response = await this.prisma.feedbackResponse.create({
      data: {
        feedbackId,
        senderId: userId,
        message: dto.message,
      },
      include: {
        sender: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    });

    if (isAdmin && feedback.userId) {
      await this.notificationsService.createFeedbackReplyNotification({
        userId: feedback.userId,
        feedbackId,
        responseId: response.id,
        message: dto.message,
      });
    }

    return response;
  }

  async archive(id: string, adminUserId: string, dto: ArchiveFeedbackDto) {
    const feedback = await this.findOne(id);

    return this.prisma.feedback.update({
      where: { id },
      data: {
        isArchived: dto.isArchived,
        archivedAt: dto.isArchived ? new Date() : null,
        archivedBy: dto.isArchived ? adminUserId : null,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async delete(id: string) {
    const feedback = await this.findOne(id);

    await this.prisma.feedback.delete({
      where: { id },
    });

    return { message: 'Feedback deleted successfully' };
  }
}
