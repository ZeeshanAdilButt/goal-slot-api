import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { GoalsService } from '../goals/goals.service';
import { CompleteTaskDto, CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';
import { Prisma, TaskStatus, TimeEntrySource } from '@prisma/client';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private goalsService: GoalsService,
  ) {}

  async create(userId: string, dto: CreateTaskDto) {
    await this.validateRelations(userId, dto.goalId, dto.scheduleBlockId);

    return this.prisma.task.create({
      data: {
        title: dto.title,
        description: dto.description,
        category: dto.category,
        status: dto.status || TaskStatus.BACKLOG,
        estimatedMinutes: dto.estimatedMinutes,
        userId,
        goalId: dto.goalId,
        scheduleBlockId: dto.scheduleBlockId,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });
  }

  async findAll(
    userId: string,
    filters: { status?: TaskStatus; scheduleBlockId?: string; goalId?: string; dayOfWeek?: number },
  ) {
    const where: Prisma.TaskWhereInput = { userId };
    if (filters.status) where.status = filters.status;
    if (filters.scheduleBlockId) where.scheduleBlockId = filters.scheduleBlockId;
    if (filters.goalId) where.goalId = filters.goalId;
    if (filters.dayOfWeek !== undefined) {
      where.scheduleBlock = { is: { dayOfWeek: filters.dayOfWeek } };
    }

    const tasks = await this.prisma.task.findMany({
      where,
      // @ts-ignore
      orderBy: [{ status: 'asc' }, { order: 'asc' }, { createdAt: 'desc' }],
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
        timeEntries: { select: { duration: true } },
      },
    });

    return tasks.map((task) => ({
      ...task,
      trackedMinutes: task.timeEntries.reduce((sum, entry) => sum + entry.duration, 0),
      timeEntries: undefined,
    }));
  }

  async findOne(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
        timeEntries: { select: { duration: true } },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return {
      ...task,
      trackedMinutes: task.timeEntries.reduce((sum, entry) => sum + entry.duration, 0),
      timeEntries: undefined,
    };
  }

  async update(userId: string, taskId: string, dto: UpdateTaskDto) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, userId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    await this.validateRelations(userId, dto.goalId, dto.scheduleBlockId);

    return this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...dto,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });
  }

  async reorder(userId: string, ids: string[]) {
    return this.prisma.$transaction(
      ids.map((id, index) =>
        // @ts-ignore
        this.prisma.task.updateMany({
          where: { id, userId },
          data: { order: index },
        }),
      ),
    );
  }

  async complete(userId: string, taskId: string, dto: CompleteTaskDto) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
      include: { goal: true, scheduleBlock: true },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const logDate = dto.date ? new Date(dto.date) : new Date();
    const dayOfWeek = logDate.getDay();

    // Get already tracked time from TRACKER source entries
    const trackedEntries = await this.prisma.timeEntry.findMany({
      where: {
        taskId: taskId,
        source: TimeEntrySource.TRACKER,
      },
      select: { duration: true },
    });

    const alreadyTrackedMinutes = trackedEntries.reduce((sum, entry) => sum + entry.duration, 0);
    const remainingMinutes = Math.max(0, dto.actualMinutes - alreadyTrackedMinutes);

    // Plan limit: tasks per day are enforced via time entries count
    const dayStart = new Date(logDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(logDate);
    dayEnd.setHours(23, 59, 59, 999);

    const entriesToday = await this.prisma.timeEntry.count({
      where: { userId, date: { gte: dayStart, lte: dayEnd } },
    });
    await this.authService.checkPlanLimit(userId, 'tasksPerDay', entriesToday);

    // Only create time entry if there's remaining time to log
    let timeEntry = null;
    if (remainingMinutes > 0) {
      timeEntry = await this.prisma.timeEntry.create({
        data: {
          taskName: task.title,
          duration: remainingMinutes,
          date: logDate,
          dayOfWeek,
          notes: dto.notes || 'Logged from task completion',
          userId,
          goalId: task.goalId,
          scheduleBlockId: task.scheduleBlockId,
          taskId: task.id,
          source: TimeEntrySource.COMPLETION,
        },
        include: {
          goal: true,
          scheduleBlock: true,
        },
      });
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.DONE,
        actualMinutes: dto.actualMinutes,
        completedAt: logDate,
      },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });

    // Update goal progress with only the remaining time
    // Note: Tracked time entries already updated the goal, so we only add remaining time
    if (task.goalId && remainingMinutes > 0) {
      await this.goalsService.updateProgress(task.goalId, remainingMinutes);
    }

    return { 
      task: updatedTask, 
      timeEntry,
      alreadyTrackedMinutes,
      remainingMinutes,
      totalMinutes: dto.actualMinutes,
    };
  }

  async restore(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
      include: { goal: true },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    // Find the completion time entry
    const completionEntry = await this.prisma.timeEntry.findFirst({
      where: {
        taskId: taskId,
        source: TimeEntrySource.COMPLETION,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Transaction to ensure consistency
    await this.prisma.$transaction(async (tx) => {
      // 1. Update Task
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.TODO,
          actualMinutes: null,
          completedAt: null,
        },
      });

      // 2. Handle Goal Progress
      // Only subtract the completion entry duration if it exists
      // (If no completion entry exists, all time was already tracked, so nothing was added to goal)
      if (task.goalId && completionEntry) {
        const minutesToSubtract = completionEntry.duration;
        const hoursToSubtract = minutesToSubtract / 60;
        
        await tx.goal.update({
            where: { id: task.goalId },
            data: {
                loggedHours: { decrement: hoursToSubtract }
            }
        });
      }

      // 3. Handle Time Entry
      if (completionEntry) {
        await tx.timeEntry.delete({
          where: { id: completionEntry.id },
        });
      }
    });

    return { message: 'Task restored successfully' };
  }

  
  async delete(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, userId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    return { message: 'Task deleted successfully' };
  }

  private async validateRelations(userId: string, goalId?: string, scheduleBlockId?: string) {
    if (goalId) {
      const goal = await this.prisma.goal.findFirst({ where: { id: goalId, userId } });
      if (!goal) throw new ForbiddenException('Goal not found or access denied');
    }

    if (scheduleBlockId) {
      const block = await this.prisma.scheduleBlock.findFirst({ where: { id: scheduleBlockId, userId } });
      if (!block) throw new ForbiddenException('Schedule block not found or access denied');
    }
  }
}



