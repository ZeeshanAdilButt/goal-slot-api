import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
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
        id: dto.id ?? undefined,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        status: dto.status || TaskStatus.BACKLOG,
        estimatedMinutes: dto.estimatedMinutes,
        userId,
        goalId: dto.goalId,
        scheduleBlockId: dto.scheduleBlockId,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        notes: dto.notes,
      },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });
  }

  async findAll(
    userId: string,
    filters: {
      status?: TaskStatus;
      statuses?: TaskStatus[];
      scheduleBlockId?: string;
      goalId?: string;
      dayOfWeek?: number;
    },
  ) {
    const where: Prisma.TaskWhereInput = { userId };

    // Handle multiple statuses or single status
    if (filters.statuses && filters.statuses.length > 0) {
      where.status = { in: filters.statuses };
    } else if (filters.status) {
      where.status = filters.status;
    }

    if (filters.scheduleBlockId)
      where.scheduleBlockId = filters.scheduleBlockId;
    if (filters.goalId) where.goalId = filters.goalId;
    if (filters.dayOfWeek !== undefined) {
      where.scheduleBlock = { is: { dayOfWeek: filters.dayOfWeek } };
    }

    const tasks = await this.prisma.task.findMany({
      where,
      orderBy: [{ status: 'asc' }, { order: 'asc' }, { createdAt: 'desc' }],
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });

    const trackedByTaskId = await this.sumTrackedMinutes(
      tasks.map((task) => task.id),
    );

    return tasks.map((task) => ({
      ...task,
      trackedMinutes: trackedByTaskId.get(task.id) ?? 0,
    }));
  }

  /**
   * Total tracked minutes per task, summed in the database.
   *
   * This replaces an `include: { timeEntries: { select: { duration: true } } }`
   * with a `reduce` in JS. That read one row for every TimeEntry the user had
   * ever logged, on every tasks-list load, on both clients, forever — a
   * two-year daily user carries a couple of thousand entries and paid for all
   * of them to compute a handful of sums that were then discarded. The
   * aggregate is O(tasks) instead of O(entries).
   *
   * Deliberately NOT filtered by `source`. The reducer this replaces had no
   * filter either, so adding one here would silently change every task's
   * displayed minutes. (`logTime` filters on `source: TRACKER`, but that is a
   * different code path with a different meaning.)
   */
  private async sumTrackedMinutes(
    taskIds: string[],
  ): Promise<Map<string, number>> {
    const byTaskId = new Map<string, number>();
    if (taskIds.length === 0) return byTaskId;

    const sums = await this.prisma.timeEntry.groupBy({
      by: ['taskId'],
      where: { taskId: { in: taskIds } },
      _sum: { duration: true },
    });

    for (const row of sums) {
      if (row.taskId) byTaskId.set(row.taskId, row._sum.duration ?? 0);
    }
    return byTaskId;
  }

  async findOne(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const trackedByTaskId = await this.sumTrackedMinutes([task.id]);

    return {
      ...task,
      trackedMinutes: trackedByTaskId.get(task.id) ?? 0,
    };
  }

  async update(userId: string, taskId: string, dto: UpdateTaskDto) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    await this.validateRelations(userId, dto.goalId, dto.scheduleBlockId);

    const { id: _id, ...updateData } = dto;

    return this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...updateData,
        // Three distinct cases, and the old `dto.dueDate ? ... : undefined`
        // collapsed the first two: an explicit `null` (clear it) became
        // `undefined`, which Prisma reads as "leave unchanged", so a due date
        // could never be removed once set.
        //   null      -> clear the stored date
        //   a string  -> set it
        //   undefined -> key absent from the payload, leave unchanged
        dueDate:
          dto.dueDate === null
            ? null
            : dto.dueDate
              ? new Date(dto.dueDate)
              : undefined,
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

    const alreadyTrackedMinutes = trackedEntries.reduce(
      (sum, entry) => sum + entry.duration,
      0,
    );
    const remainingMinutes = Math.max(
      0,
      dto.actualMinutes - alreadyTrackedMinutes,
    );

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
      await this.goalsService.updateProgress(task.goalId, userId);
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
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.TODO,
          actualMinutes: null,
          completedAt: null,
        },
      });

      if (completionEntry) {
        await tx.timeEntry.delete({
          where: { id: completionEntry.id },
        });
      }

      // Recompute loggedHours from the live SUM after the deletion so the
      // goal stays in sync regardless of which entries existed before.
      if (task.goalId) {
        const agg = await tx.timeEntry.aggregate({
          where: { goalId: task.goalId },
          _sum: { duration: true },
        });
        await tx.goal.update({
          where: { id: task.goalId },
          data: { loggedHours: (agg._sum.duration ?? 0) / 60 },
        });
      }
    });

    return { message: 'Task restored successfully' };
  }

  async delete(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    return { message: 'Task deleted successfully' };
  }

  private async validateRelations(
    userId: string,
    goalId?: string,
    scheduleBlockId?: string,
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
      if (!block)
        throw new ForbiddenException(
          'Schedule block not found or access denied',
        );
    }
  }
}
