import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

  /**
   * Every relation on a time entry is client-supplied, so each one has to be
   * confirmed to belong to the caller before it is written. Without this a
   * caller could point an entry at a stranger's goal, read that goal back out
   * of the `include: { goal: true }` response (private goals included), and
   * have their own minutes folded into the victim's loggedHours.
   *
   * Mirrors TasksService.validateRelations, extended to cover taskId, which
   * time entries also carry.
   */
  private async validateRelations(
    userId: string,
    goalId?: string | null,
    scheduleBlockId?: string | null,
    taskId?: string | null,
  ) {
    if (goalId) {
      const goal = await this.prisma.goal.findFirst({
        where: { id: goalId, userId },
      });
      if (!goal)
        throw new ForbiddenException('Goal not found or access denied');
    }

    if (scheduleBlockId) {
      const block = await this.prisma.scheduleBlock.findFirst({
        where: { id: scheduleBlockId, userId },
      });
      if (!block) {
        throw new ForbiddenException(
          'Schedule block not found or access denied',
        );
      }
    }

    if (taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: taskId, userId },
      });
      if (!task)
        throw new ForbiddenException('Task not found or access denied');
    }
  }

  async create(userId: string, dto: CreateTimeEntryDto) {
    await this.validateRelations(
      userId,
      dto.goalId,
      dto.scheduleBlockId,
      dto.taskId,
    );

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
        id: dto.id ?? undefined,
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
      // Trimmed to the fields every other reader of TimeEntry.goal in this
      // service uses (see findByDateRange/getRecentEntries below) — `goal:
      // true` was pulling the entire Goal row (description, loggedHours,
      // targetHours, deadline, templateId, ...) into every create response
      // even though only id/title/color/category are ever read off it.
      include: {
        goal: {
          select: { id: true, title: true, color: true, category: true },
        },
      },
    });

    // Update goal progress if linked
    if (dto.goalId) {
      await this.goalsService.updateProgress(dto.goalId, userId);
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
      orderBy: [{ date: 'desc' }, { startedAt: 'desc' }, { createdAt: 'desc' }],
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
    await this.validateRelations(
      userId,
      dto.goalId,
      dto.scheduleBlockId,
      dto.taskId,
    );

    const entry = await this.prisma.timeEntry.findFirst({
      where: { id: entryId, userId },
    });

    if (!entry) {
      throw new NotFoundException('Time entry not found');
    }

    const oldGoalId = entry.goalId;

    let taskTitle = dto.taskTitle;
    if (dto.taskId && !taskTitle) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, userId },
        select: { title: true },
      });
      taskTitle = task?.title;
    }

    const { id: _id, ...updateData } = dto;

    const updated = await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        ...updateData,
        date: dto.date ? new Date(dto.date) : undefined,
        dayOfWeek: dto.date ? new Date(dto.date).getDay() : undefined,
        startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
        taskTitle,
      },
      // Same trim as create() above, for the same reason.
      include: {
        goal: {
          select: { id: true, title: true, color: true, category: true },
        },
      },
    });

    if (dto.duration !== undefined || dto.goalId !== undefined) {
      const newGoalId = dto.goalId ?? oldGoalId;
      if (oldGoalId && oldGoalId !== newGoalId) {
        await this.goalsService.updateProgress(oldGoalId, userId);
      }
      if (newGoalId) {
        await this.goalsService.updateProgress(newGoalId, userId);
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

    await this.prisma.timeEntry.delete({ where: { id: entryId } });

    if (entry.goalId) {
      await this.goalsService.updateProgress(entry.goalId, userId);
    }
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
    params?: {
      page?: number;
      pageSize?: number;
      startDate?: string;
      endDate?: string;
      search?: string;
      goalId?: string;
    },
  ) {
    const page = params?.page && params.page > 0 ? params.page : 1;
    const pageSize =
      params?.pageSize && params.pageSize > 0
        ? Math.min(params.pageSize, 100)
        : 10;

    const where: Prisma.TimeEntryWhereInput = { userId };

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

    const search = params?.search?.trim();
    if (search) {
      where.OR = [
        { taskName: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (params?.goalId) {
      // Sentinel for "entries without a goal" so the UI can offer it as
      // an explicit filter (otherwise "no goal" is indistinguishable from
      // "no filter").
      if (params.goalId === '__NO_GOAL__') {
        where.goalId = null;
      } else {
        where.goalId = params.goalId;
      }
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
