import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFeedbackDto, ArchiveFeedbackDto } from './dto/feedback.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class FeedbackService {
  constructor(private prisma: PrismaService) {}

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
