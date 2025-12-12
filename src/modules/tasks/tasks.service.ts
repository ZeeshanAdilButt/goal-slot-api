import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { GoalsService } from '../goals/goals.service';
import { CompleteTaskDto, CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';
import { TaskStatus } from '@prisma/client';

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
        status: dto.status || TaskStatus.PENDING,
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
    const where: any = { userId };
    if (filters.status) where.status = filters.status;
    if (filters.scheduleBlockId) where.scheduleBlockId = filters.scheduleBlockId;
    if (filters.goalId) where.goalId = filters.goalId;
    if (filters.dayOfWeek !== undefined) {
      where.scheduleBlock = { dayOfWeek: Number(filters.dayOfWeek) };
    }

    return this.prisma.task.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });
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

    return task;
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

    // Plan limit: tasks per day are enforced via time entries count
    const dayStart = new Date(logDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(logDate);
    dayEnd.setHours(23, 59, 59, 999);

    const entriesToday = await this.prisma.timeEntry.count({
      where: { userId, date: { gte: dayStart, lte: dayEnd } },
    });
    await this.authService.checkPlanLimit(userId, 'tasksPerDay', entriesToday);

    const timeEntry = await this.prisma.timeEntry.create({
      data: {
        taskName: task.title,
        duration: dto.actualMinutes,
        date: logDate,
        dayOfWeek,
        notes: dto.notes || 'Logged from task completion',
        userId,
        goalId: task.goalId,
        scheduleBlockId: task.scheduleBlockId,
        taskId: task.id,
      },
      include: {
        goal: true,
        scheduleBlock: true,
      },
    });

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.COMPLETED,
        actualMinutes: dto.actualMinutes,
        completedAt: logDate,
      },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: true,
      },
    });

    if (task.goalId) {
      await this.goalsService.updateProgress(task.goalId, dto.actualMinutes);
    }

    return { task: updatedTask, timeEntry };
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




