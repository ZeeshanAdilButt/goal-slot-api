import {
  BadRequestException,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { GoalsService } from '../goals/goals.service';
import { CompleteTaskDto, CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';
import {
  Prisma,
  ProjectRole,
  TaskStatus,
  TimeEntrySource,
} from '@prisma/client';
import {
  assertProjectAccess,
  assertTaskAccess,
  getProjectRole,
  requesterMembershipSelect,
  roleCanWrite,
} from '../projects/project-access';

export type TaskListScope = 'mine' | 'personal';

export interface TaskListFilters {
  status?: TaskStatus;
  statuses?: TaskStatus[];
  scheduleBlockId?: string;
  goalId?: string;
  dayOfWeek?: number;
  scope?: TaskListScope;
  projectId?: string;
  assignee?: string;
}

/** The fields present() reads; every task include in this service has them. */
interface PresentableTask {
  userId: string;
  projectId?: string | null;
  project?: {
    id: string;
    name: string;
    color: string;
    members?: Array<{ role: ProjectRole }>;
  } | null;
  assignee?: { id: string; name: string; avatar: string | null } | null;
}

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private goalsService: GoalsService,
  ) {}

  /**
   * Relations every task response carries. `project` only ever pulls the
   * requester's own membership row (for `canEdit`), never the member list.
   */
  private taskInclude(userId: string) {
    return {
      goal: { select: { id: true, title: true, color: true } },
      scheduleBlock: true,
      project: requesterMembershipSelect(userId),
      assignee: { select: { id: true, name: true, avatar: true } },
    };
  }

  /**
   * Shapes a task for the requester.
   *
   * Goals and schedule blocks stay personal. A task's goal and block can only
   * be set by its creator, to the creator's own rows (validateRelations), so
   * "requester is the creator" is exactly "requester owns that goal/block".
   * Everyone else on the project gets them as null, which is what keeps a
   * project from becoming a window into a teammate's goals or schedule.
   *
   * For a personal task the requester is always the creator, so the response
   * is the old shape plus `project: null`, `assignee: null`, `canEdit: true`.
   */
  private present<T extends PresentableTask>(userId: string, task: T) {
    const { project, ...rest } = task;
    const isCreator = task.userId === userId;
    const role = project?.members?.[0]?.role ?? null;

    const out = {
      ...rest,
      project: project
        ? { id: project.id, name: project.name, color: project.color }
        : null,
      assignee: task.assignee ?? null,
      canEdit: task.projectId == null ? isCreator : roleCanWrite(role),
    };

    if (!isCreator) {
      Object.assign(out, {
        goalId: null,
        goal: null,
        scheduleBlockId: null,
        scheduleBlock: null,
      });
    }
    return out;
  }

  /** An assignee must be a member (any role) of the task's project. */
  private async assertAssignable(projectId: string, assigneeId: string) {
    const role = await getProjectRole(this.prisma, assigneeId, projectId);
    if (!role) {
      throw new BadRequestException(
        'Assignee must be a member of this project',
      );
    }
  }

  async create(userId: string, dto: CreateTaskDto) {
    if (dto.assigneeId && !dto.projectId) {
      throw new BadRequestException('assigneeId requires projectId');
    }
    if (dto.projectId) {
      await assertProjectAccess(this.prisma, userId, dto.projectId, 'write');
      if (dto.assigneeId) {
        await this.assertAssignable(dto.projectId, dto.assigneeId);
      }
    }

    await this.validateRelations(userId, dto.goalId, dto.scheduleBlockId);

    const task = await this.prisma.task.create({
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
        projectId: dto.projectId ?? undefined,
        assigneeId: dto.assigneeId ?? undefined,
      },
      include: this.taskInclude(userId),
    });

    return this.present(userId, task);
  }

  /**
   * Scope rules (spec "Tasks"):
   *  - projectId: every task in that project; membership required (404
   *    otherwise). Optional `assignee` = me | unassigned | <userId>.
   *  - scope=personal: exactly the old query, `userId = me AND projectId
   *    IS NULL`.
   *  - scope=mine (the default, which is what the mobile app gets): my
   *    personal tasks, plus project tasks assigned to me, plus project tasks
   *    I created that nobody has picked up. Project tasks always require a
   *    live membership, so a removed member stops seeing tasks they created.
   *
   * For a user with no projects, `mine` returns exactly the rows the old
   * `{ userId }` query did, because every one of their tasks has
   * projectId = NULL.
   */
  async findAll(userId: string, filters: TaskListFilters) {
    let where: Prisma.TaskWhereInput;
    let personalOnly = false;

    if (filters.projectId) {
      await assertProjectAccess(this.prisma, userId, filters.projectId, 'read');
      where = { projectId: filters.projectId };
      if (filters.assignee === 'me') where.assigneeId = userId;
      else if (filters.assignee === 'unassigned') where.assigneeId = null;
      else if (filters.assignee) where.assigneeId = filters.assignee;
    } else if (filters.assignee) {
      throw new BadRequestException('assignee requires projectId');
    } else if (filters.scope === 'personal') {
      where = { userId, projectId: null };
      personalOnly = true;
    } else {
      where = {
        OR: [
          { userId, projectId: null },
          {
            project: {
              is: { archivedAt: null, members: { some: { userId } } },
            },
            OR: [{ assigneeId: userId }, { assigneeId: null, userId }],
          },
        ],
      };
    }

    // Handle multiple statuses or single status
    if (filters.statuses && filters.statuses.length > 0) {
      where.status = { in: filters.statuses };
    } else if (filters.status) {
      where.status = filters.status;
    }

    if (filters.scheduleBlockId)
      where.scheduleBlockId = filters.scheduleBlockId;
    if (filters.goalId) where.goalId = filters.goalId;

    if (personalOnly) {
      if (filters.dayOfWeek !== undefined) {
        where.scheduleBlock = { is: { dayOfWeek: filters.dayOfWeek } };
      }
    } else {
      // Goals and schedule blocks are personal: on any view that can include
      // other people's tasks, these filters only match the requester's own.
      if (filters.goalId) where.goal = { is: { userId } };
      if (filters.scheduleBlockId || filters.dayOfWeek !== undefined) {
        where.scheduleBlock = {
          is: {
            userId,
            ...(filters.dayOfWeek !== undefined
              ? { dayOfWeek: filters.dayOfWeek }
              : {}),
          },
        };
      }
    }

    const tasks = await this.prisma.task.findMany({
      where,
      orderBy: [{ status: 'asc' }, { order: 'asc' }, { createdAt: 'desc' }],
      include: this.taskInclude(userId),
    });

    const trackedByTaskId = await this.sumTrackedMinutes(
      tasks.map((task) => task.id),
    );

    return tasks.map((task) => ({
      ...this.present(userId, task),
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
    const { task } = await assertTaskAccess(
      this.prisma,
      userId,
      taskId,
      'read',
      this.taskInclude(userId),
    );

    const trackedByTaskId = await this.sumTrackedMinutes([task.id]);

    return {
      ...this.present(userId, task),
      trackedMinutes: trackedByTaskId.get(task.id) ?? 0,
    };
  }

  async update(userId: string, taskId: string, dto: UpdateTaskDto) {
    const { task, isCreator } = await assertTaskAccess(
      this.prisma,
      userId,
      taskId,
      'write',
    );

    const {
      id: _id,
      projectId: dtoProjectId,
      assigneeId: dtoAssigneeId,
      ...updateData
    } = dto;

    // Goals and schedule blocks are personal and belong to the creator.
    // Another member's edit form never sees them (they come back null), so
    // whatever it sends for these two keys is dropped rather than allowed to
    // clear or repoint the creator's links.
    if (!isCreator) {
      delete updateData.goalId;
      delete updateData.scheduleBlockId;
    } else {
      await this.validateRelations(userId, dto.goalId, dto.scheduleBlockId);
    }

    const placement = await this.resolvePlacement(
      userId,
      task,
      isCreator,
      dtoProjectId,
      dtoAssigneeId,
    );

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...updateData,
        ...placement,
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
      include: this.taskInclude(userId),
    });

    return this.present(userId, updated);
  }

  /**
   * Works out the projectId / assigneeId part of an update. Returns only the
   * keys that actually change, so an ordinary personal-task edit writes
   * exactly what it did before.
   *
   *  - Only the creator may move a task between projects (or back to
   *    personal), and only into a project they can write to.
   *  - An assignee must be a member of the task's (new) project. Moving a
   *    task clears an inherited assignee who is not a member there; an
   *    explicitly requested one who is not a member is a 400.
   */
  private async resolvePlacement(
    userId: string,
    task: { projectId?: string | null; assigneeId?: string | null },
    isCreator: boolean,
    dtoProjectId: string | null | undefined,
    dtoAssigneeId: string | null | undefined,
  ): Promise<{ projectId?: string | null; assigneeId?: string | null }> {
    const out: { projectId?: string | null; assigneeId?: string | null } = {};
    const currentProjectId = task.projectId ?? null;
    let nextProjectId = currentProjectId;

    if (
      dtoProjectId !== undefined &&
      (dtoProjectId ?? null) !== currentProjectId
    ) {
      if (!isCreator) {
        throw new ForbiddenException(
          'Only the task creator can move it to another project',
        );
      }
      if (dtoProjectId) {
        await assertProjectAccess(this.prisma, userId, dtoProjectId, 'write');
      }
      nextProjectId = dtoProjectId ?? null;
      out.projectId = nextProjectId;
    }
    const moved = out.projectId !== undefined;

    if (nextProjectId === null) {
      if (dtoAssigneeId) {
        throw new BadRequestException('assigneeId requires projectId');
      }
      if (dtoAssigneeId === null || (moved && task.assigneeId)) {
        out.assigneeId = null;
      }
      return out;
    }

    if (dtoAssigneeId !== undefined) {
      if (dtoAssigneeId)
        await this.assertAssignable(nextProjectId, dtoAssigneeId);
      out.assigneeId = dtoAssigneeId;
    } else if (moved && task.assigneeId) {
      const stillMember = await getProjectRole(
        this.prisma,
        task.assigneeId,
        nextProjectId,
      );
      if (!stillMember) out.assigneeId = null;
    }
    return out;
  }

  /**
   * Without projectId (what the web and mobile send), each id is reordered
   * only if the caller can write it: a personal task they own (exactly the
   * old per-user rule) or a task in a project where they are ADMIN or
   * MEMBER. Ids they cannot write are skipped, as foreign ids always were.
   * With projectId, write access to that project is required up front and
   * only tasks in that project are touched.
   */
  async reorder(userId: string, ids: string[], projectId?: string) {
    if (projectId) {
      if (typeof projectId !== 'string') {
        throw new BadRequestException('projectId must be a string');
      }
      await assertProjectAccess(this.prisma, userId, projectId, 'write');
      return this.prisma.$transaction(
        ids.map((id, index) =>
          this.prisma.task.updateMany({
            where: { id, projectId },
            data: { order: index },
          }),
        ),
      );
    }

    return this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.task.updateMany({
          where: {
            id,
            OR: [
              { userId, projectId: null },
              {
                project: {
                  is: {
                    members: {
                      some: {
                        userId,
                        role: { in: [ProjectRole.ADMIN, ProjectRole.MEMBER] },
                      },
                    },
                  },
                },
              },
            ],
          },
          data: { order: index },
        }),
      ),
    );
  }

  async complete(userId: string, taskId: string, dto: CompleteTaskDto) {
    const { task } = await assertTaskAccess(
      this.prisma,
      userId,
      taskId,
      'write',
      { goal: true, scheduleBlock: true },
    );

    // The completion entry is the ACTOR's time entry, so it may only carry
    // the actor's own goal and schedule block. On a personal task those are
    // always the actor's; on a project task completed by someone other than
    // the creator they are the creator's, and are left off.
    const ownGoalId =
      task.goalId && task.goal?.userId === userId ? task.goalId : null;
    const ownScheduleBlockId =
      task.scheduleBlockId && task.scheduleBlock?.userId === userId
        ? task.scheduleBlockId
        : null;

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
          goalId: ownGoalId,
          scheduleBlockId: ownScheduleBlockId,
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
      include: this.taskInclude(userId),
    });

    // Update goal progress with only the remaining time
    // Note: Tracked time entries already updated the goal, so we only add remaining time
    if (ownGoalId && remainingMinutes > 0) {
      await this.goalsService.updateProgress(ownGoalId, userId);
    }

    return {
      task: this.present(userId, updatedTask),
      timeEntry,
      alreadyTrackedMinutes,
      remainingMinutes,
      totalMinutes: dto.actualMinutes,
    };
  }

  async restore(userId: string, taskId: string) {
    const { task } = await assertTaskAccess(
      this.prisma,
      userId,
      taskId,
      'write',
      { goal: true },
    );

    // The completion entry belongs to whoever completed the task, which on a
    // project task may be another member. Restoring un-completes the task, so
    // that entry goes too, whoever owns it: otherwise completing it again
    // would count the completer's time twice. Tracker and manual entries are
    // untouched (only source COMPLETION is removed). On a personal task the
    // only possible completer is the owner, so behaviour there is unchanged.
    const completionEntry = await this.prisma.timeEntry.findFirst({
      where: {
        taskId: taskId,
        source: TimeEntrySource.COMPLETION,
      },
      orderBy: { createdAt: 'desc' },
    });

    const ownGoalId =
      task.goalId && task.goal?.userId === userId ? task.goalId : null;
    // Goals whose loggedHours change: the actor's own goal on this task, and
    // the goal the deleted completion entry counted toward (the completer's).
    const goalIdsToRecompute = [
      ...new Set(
        [ownGoalId, completionEntry?.goalId ?? null].filter(
          (id): id is string => !!id,
        ),
      ),
    ];

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
      for (const goalId of goalIdsToRecompute) {
        const agg = await tx.timeEntry.aggregate({
          where: { goalId },
          _sum: { duration: true },
        });
        await tx.goal.update({
          where: { id: goalId },
          data: { loggedHours: (agg._sum.duration ?? 0) / 60 },
        });
      }
    });

    return { message: 'Task restored successfully' };
  }

  async delete(userId: string, taskId: string) {
    await assertTaskAccess(this.prisma, userId, taskId, 'delete');

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    return { message: 'Task deleted successfully' };
  }

  private async validateRelations(
    userId: string,
    goalId?: string | null,
    scheduleBlockId?: string | null,
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
