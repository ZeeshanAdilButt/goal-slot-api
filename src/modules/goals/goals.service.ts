import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { CreateGoalDto, UpdateGoalDto } from './dto/goals.dto';
import { GoalStatus } from '@prisma/client';

@Injectable()
export class GoalsService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
  ) {}

  async create(userId: string, dto: CreateGoalDto) {
    // Check plan limits
    const currentGoals = await this.prisma.goal.count({
      where: { userId, status: { not: GoalStatus.COMPLETED } },
    });
    await this.authService.checkPlanLimit(userId, 'goals', currentGoals);

    return this.prisma.goal.create({
      data: {
        ...dto,
        userId,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
      },
    });
  }

  async findAll(userId: string, status?: GoalStatus) {
    const where: any = { userId };
    if (status) where.status = status;

    return this.prisma.goal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { timeEntries: true },
        },
      },
    });
  }

  async findOne(userId: string, goalId: string) {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      include: {
        timeEntries: {
          orderBy: { date: 'desc' },
          take: 10,
        },
      },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    return goal;
  }

  async update(userId: string, goalId: string, dto: UpdateGoalDto) {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    return this.prisma.goal.update({
      where: { id: goalId },
      data: {
        ...dto,
        deadline: dto.deadline ? new Date(dto.deadline) : undefined,
      },
    });
  }

  async delete(userId: string, goalId: string) {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    await this.prisma.goal.delete({ where: { id: goalId } });
    return { message: 'Goal deleted successfully' };
  }

  async updateProgress(goalId: string, additionalMinutes: number) {
    const goal = await this.prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) return;

    const additionalHours = additionalMinutes / 60;
    const newLoggedHours = goal.loggedHours + additionalHours;

    await this.prisma.goal.update({
      where: { id: goalId },
      data: {
        loggedHours: newLoggedHours,
        status: newLoggedHours >= goal.targetHours ? GoalStatus.COMPLETED : goal.status,
      },
    });
  }

  async getStats(userId: string) {
    const [active, completed, paused] = await Promise.all([
      this.prisma.goal.count({ where: { userId, status: GoalStatus.ACTIVE } }),
      this.prisma.goal.count({ where: { userId, status: GoalStatus.COMPLETED } }),
      this.prisma.goal.count({ where: { userId, status: GoalStatus.PAUSED } }),
    ]);

    return { active, completed, paused, total: active + completed + paused };
  }
}
