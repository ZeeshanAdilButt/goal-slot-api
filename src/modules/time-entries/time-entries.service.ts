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
          select: { id: true, title: true, color: true },
        },
        scheduleBlock: {
          select: { id: true, title: true },
        },
      },
      orderBy: { date: 'asc' },
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

    const updated = await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        ...dto,
        date: dto.date ? new Date(dto.date) : undefined,
        dayOfWeek: dto.date ? new Date(dto.date).getDay() : undefined,
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

  async getRecentEntries(userId: string, limit = 5) {
    return this.prisma.timeEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        goal: {
          select: { id: true, title: true, color: true },
        },
      },
    });
  }
}
