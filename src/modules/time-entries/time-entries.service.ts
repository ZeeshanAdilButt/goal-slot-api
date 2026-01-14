import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { GoalsService } from '../goals/goals.service';
import { CreateTimeEntryDto, UpdateTimeEntryDto } from './dto/time-entries.dto';

@Injectable()
export class TimeEntriesService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private goalsService: GoalsService,
  ) {}

  async create(userId: string, dto: CreateTimeEntryDto) {
    const date = new Date(dto.date);
    const dayOfWeek = date.getDay();
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : date;

    let taskTitle = dto.taskTitle;
    if (dto.taskId && !taskTitle) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, userId },
        select: { title: true },
      });
      taskTitle = task?.title;
    }

    // Check daily task limit
    const todayStart = new Date(date);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(date);
    todayEnd.setHours(23, 59, 59, 999);

    const todayEntries = await this.prisma.timeEntry.count({
      where: {
        userId,
        date: { gte: todayStart, lte: todayEnd },
      },
    });

    await this.authService.checkPlanLimit(userId, 'tasksPerDay', todayEntries);

    const entry = await this.prisma.timeEntry.create({
      data: {
        taskName: dto.taskName,
        duration: dto.duration,
        date,
        dayOfWeek,
        notes: dto.notes,
        userId,
        goalId: dto.goalId,
        scheduleBlockId: dto.scheduleBlockId,
        taskId: dto.taskId,
        taskTitle,
        startedAt,
      },
      include: {
        goal: true,
      },
    });

    // Update goal progress if linked
    if (dto.goalId) {
      await this.goalsService.updateProgress(dto.goalId, dto.duration);
    }

    return entry;
  }

  async findByDateRange(userId: string, startDate: string, endDate: string) {
    return this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      },
      include: {
        goal: {
          select: { id: true, title: true, color: true, category: true },
        },
        scheduleBlock: {
          select: { id: true, title: true, category: true },
        },
        task: {
          select: { id: true, title: true, category: true },
        },
      },
      orderBy: [
        { date: 'desc' },
        { startedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });
  }

  async findByWeek(userId: string, weekStart: string) {
    const start = new Date(weekStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    return this.findByDateRange(userId, start.toISOString(), end.toISOString());
  }

  async update(userId: string, entryId: string, dto: UpdateTimeEntryDto) {
    const entry = await this.prisma.timeEntry.findFirst({
      where: { id: entryId, userId },
    });

    if (!entry) {
      throw new NotFoundException('Time entry not found');
    }

    const oldDuration = entry.duration;
    const oldGoalId = entry.goalId;

    let taskTitle = dto.taskTitle;
    if (dto.taskId && !taskTitle) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, userId },
        select: { title: true },
      });
      taskTitle = task?.title;
    }

    const updated = await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        ...dto,
        date: dto.date ? new Date(dto.date) : undefined,
        dayOfWeek: dto.date ? new Date(dto.date).getDay() : undefined,
        startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
        taskTitle,
      },
      include: { goal: true },
    });

    // Update goal progress if duration or goal changed
    if (dto.duration || dto.goalId) {
      // Revert old goal progress
      if (oldGoalId) {
        await this.goalsService.updateProgress(oldGoalId, -oldDuration);
      }
      // Add to new/current goal
      const newGoalId = dto.goalId || entry.goalId;
      if (newGoalId) {
        await this.goalsService.updateProgress(newGoalId, dto.duration || oldDuration);
      }
    }

    return updated;
  }

  async delete(userId: string, entryId: string) {
    const entry = await this.prisma.timeEntry.findFirst({
      where: { id: entryId, userId },
    });

    if (!entry) {
      throw new NotFoundException('Time entry not found');
    }

    // Revert goal progress
    if (entry.goalId) {
      await this.goalsService.updateProgress(entry.goalId, -entry.duration);
    }

    await this.prisma.timeEntry.delete({ where: { id: entryId } });
    return { message: 'Time entry deleted' };
  }

  async getTodayTotal(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const result = await this.prisma.timeEntry.aggregate({
      where: {
        userId,
        date: { gte: today, lt: tomorrow },
      },
      _sum: { duration: true },
      _count: true,
    });

    return {
      totalMinutes: result._sum.duration || 0,
      totalHours: ((result._sum.duration || 0) / 60).toFixed(1),
      tasksLogged: result._count,
    };
  }

  async getWeeklyTotal(userId: string) {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dayOfWeek + 1); // Monday
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const result = await this.prisma.timeEntry.aggregate({
      where: {
        userId,
        date: { gte: weekStart, lte: weekEnd },
      },
      _sum: { duration: true },
      _count: true,
    });

    return {
      totalMinutes: result._sum.duration || 0,
      totalHours: ((result._sum.duration || 0) / 60).toFixed(1),
      tasksLogged: result._count,
    };
  }

  async getRecentEntries(
    userId: string,
    params?: { page?: number; pageSize?: number; startDate?: string; endDate?: string },
  ) {
    const page = params?.page && params.page > 0 ? params.page : 1;
    const pageSize = params?.pageSize && params.pageSize > 0 ? Math.min(params.pageSize, 100) : 10;

    const where: any = { userId };

    if (params?.startDate || params?.endDate) {
      const start = params.startDate ? new Date(params.startDate) : undefined;
      const end = params.endDate ? new Date(params.endDate) : undefined;

      if (end) {
        end.setHours(23, 59, 59, 999);
      }

      where.date = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where,
        orderBy: [
          { date: 'desc' },
          { startedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          goal: {
            select: { id: true, title: true, color: true },
          },
        },
      }),
      this.prisma.timeEntry.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
    };
  }
}
