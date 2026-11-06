import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectRole } from '@prisma/client';

/**
 * The one place the Projects permission table lives (see
 * docs/superpowers/specs/2026-11-06-projects-in-tasks-design.md).
 *
 *   | Action                                 | ADMIN | MEMBER        | GUEST | Non-member |
 *   | see project, its tasks, members        | yes   | yes           | yes   | 404        |
 *   | create/edit/move/complete/assign/log   | yes   | yes           | 403   | 404        |
 *   | delete a task                          | yes   | only own      | 403   | 404        |
 *   | rename/recolor/archive/delete project  | yes   | 403           | 403   | 404        |
 *   | invite/revoke/change roles/remove      | yes   | 403           | 403   | 404        |
 *
 * Non-members always get 404, never 403, so project and task ids cannot be
 * probed. Personal tasks (projectId null) keep their old rule exactly: only
 * the creator, and anyone else gets 404.
 *
 * These are plain functions over a Prisma-shaped client rather than an
 * injectable, so TasksService, TimeEntriesService and ActiveTimerService can
 * all share them without changing their constructors.
 */

export type TaskAccessLevel = 'read' | 'write' | 'delete';
export type ProjectAccessLevel = 'read' | 'write' | 'admin';

// Minimal structural view of the client these helpers need. PrismaService
// and a transaction client both satisfy it, and so do the hand-written fakes
// in the specs.
type PrismaLike = {
  task: { findFirst: (args: any) => Promise<any> };
  projectMember: { findUnique: (args: any) => Promise<any> };
};

export function roleCanWrite(role: ProjectRole | null | undefined): boolean {
  return role === ProjectRole.ADMIN || role === ProjectRole.MEMBER;
}

/** Select that pulls only the requester's own membership row alongside a task. */
export function requesterMembershipSelect(userId: string) {
  return {
    select: {
      id: true,
      name: true,
      color: true,
      archivedAt: true,
      members: {
        where: { userId },
        select: { role: true },
        take: 1,
      },
    },
  } as const;
}

export interface TaskAccess<T = any> {
  task: T;
  /** The requester's role in the task's project, null for a personal task. */
  role: ProjectRole | null;
  isCreator: boolean;
}

/**
 * Pure decision over an already-loaded task. Returns null when the requester
 * must be treated as if the task did not exist (the 404 cases); throws 403
 * only for members who can see the task but not do this to it.
 */
export function decideTaskAccess<T extends { userId: string; projectId?: string | null; project?: any }>(
  userId: string,
  task: T | null,
  level: TaskAccessLevel,
): TaskAccess<T> | null {
  if (!task) return null;
  const isCreator = task.userId === userId;

  if (task.projectId == null) {
    return isCreator ? { task, role: null, isCreator } : null;
  }

  const role: ProjectRole | null = task.project?.members?.[0]?.role ?? null;
  if (!role) return null;

  if (level === 'read') return { task, role, isCreator };

  if (!roleCanWrite(role)) {
    throw new ForbiddenException(
      'Guests can view this project but cannot change its tasks',
    );
  }

  if (level === 'delete' && role !== ProjectRole.ADMIN && !isCreator) {
    throw new ForbiddenException(
      'Only project admins can delete tasks created by someone else',
    );
  }

  return { task, role, isCreator };
}

/**
 * Load a task and apply the permission table. Throws NotFoundException for
 * a missing task, someone else's personal task, or a project the requester
 * is not in.
 */
export async function assertTaskAccess(
  prisma: PrismaLike,
  userId: string,
  taskId: string,
  level: TaskAccessLevel,
  include: Record<string, unknown> = {},
): Promise<TaskAccess> {
  const task = await prisma.task.findFirst({
    where: { id: taskId },
    include: { ...include, project: requesterMembershipSelect(userId) },
  });
  const access = decideTaskAccess(userId, task, level);
  if (!access) throw new NotFoundException('Task not found');
  return access;
}

/**
 * Non-throwing variant for callers that attach time to a task (time entries,
 * the active timer). Returns the task when the requester may write to it
 * (personal owner, or ADMIN/MEMBER of its project), otherwise null, so each
 * caller keeps reporting its own existing error shape.
 */
export async function findWritableTask(
  prisma: PrismaLike,
  userId: string,
  taskId: string,
): Promise<{ id: string; title: string } | null> {
  const task = await prisma.task.findFirst({
    where: { id: taskId },
    include: { project: requesterMembershipSelect(userId) },
  });
  try {
    const access = decideTaskAccess(userId, task, 'write');
    return access ? access.task : null;
  } catch {
    return null;
  }
}

/** The requester's role in a project, or null when not a member. */
export async function getProjectRole(
  prisma: PrismaLike,
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return member?.role ?? null;
}

/**
 * Membership gate for project-level actions. Non-members get 404 for every
 * level; members below the required level get 403.
 */
export async function assertProjectAccess(
  prisma: PrismaLike,
  userId: string,
  projectId: string,
  level: ProjectAccessLevel,
): Promise<ProjectRole> {
  const role = await getProjectRole(prisma, userId, projectId);
  if (!role) throw new NotFoundException('Project not found');

  if (level === 'write' && !roleCanWrite(role)) {
    throw new ForbiddenException(
      'Guests can view this project but cannot change it',
    );
  }
  if (level === 'admin' && role !== ProjectRole.ADMIN) {
    throw new ForbiddenException('Only project admins can do this');
  }
  return role;
}
