/* eslint-disable @typescript-eslint/no-explicit-any */
// Test-only helper (not a *.spec.ts file, so the spec override in
// .eslintrc.js does not reach it). Prisma-shaped fakes need `any` for the
// same reason the specs do.
import { FakeDb } from './fake-db';
import { TasksService } from '../../tasks/tasks.service';
import { TimeEntriesService } from '../../time-entries/time-entries.service';
import { ActiveTimerService } from '../../active-timer/active-timer.service';
import { ProjectsService } from '../projects.service';
import { ProjectInvitesService } from '../project-invites.service';

export const ADMIN = 'u-admin';
export const MEMBER = 'u-member';
export const MEMBER2 = 'u-member2';
export const GUEST = 'u-guest';
export const OUTSIDER = 'u-outsider';

export class FakeGoals {
  progressCalls: Array<{ goalId: string; userId: string }> = [];
  updateProgress = async (goalId: string, userId: string) => {
    this.progressCalls.push({ goalId, userId });
  };
}

export class FakeAuth {
  checkPlanLimit = async () => true;
  checkPlanLimitForUser = async () => true;
}

export class FakeEmail {
  sent: any[] = [];
  fail = false;
  sendProjectInvitation = async (params: any) => {
    if (this.fail) throw new Error('resend down');
    this.sent.push(params);
    return { success: true };
  };
}

/**
 * One project with an ADMIN, two MEMBERs and a GUEST, plus an outsider who
 * belongs to nothing. Each member has a personal task, a personal goal and
 * a personal schedule block, so specs can check none of it crosses over.
 */
export function buildWorld() {
  const db = new FakeDb();
  const goals = new FakeGoals();
  const auth = new FakeAuth();
  const email = new FakeEmail();

  for (const [id, name] of [
    [ADMIN, 'Ada Admin'],
    [MEMBER, 'Mo Member'],
    [MEMBER2, 'Mia Member'],
    [GUEST, 'Gus Guest'],
    [OUTSIDER, 'Ola Outsider'],
  ]) {
    db.seed('user', {
      id,
      name,
      email: `${id}@example.com`,
      avatar: null,
      plan: 'FREE',
    });
  }

  const project = db.seed('project', {
    id: 'p-1',
    name: 'Launch',
    color: '#16A34A',
    createdById: ADMIN,
  });
  const joined = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, n));
  db.seed('projectMember', {
    projectId: project.id,
    userId: ADMIN,
    role: 'ADMIN',
    joinedAt: joined(0),
  });
  db.seed('projectMember', {
    projectId: project.id,
    userId: MEMBER,
    role: 'MEMBER',
    joinedAt: joined(1),
  });
  db.seed('projectMember', {
    projectId: project.id,
    userId: MEMBER2,
    role: 'MEMBER',
    joinedAt: joined(2),
  });
  db.seed('projectMember', {
    projectId: project.id,
    userId: GUEST,
    role: 'GUEST',
    joinedAt: joined(3),
  });

  const adminGoal = db.seed('goal', {
    id: 'g-admin',
    userId: ADMIN,
    title: 'Admin private goal',
    color: '#000',
  });
  const memberGoal = db.seed('goal', {
    id: 'g-member',
    userId: MEMBER,
    title: 'Member private goal',
    color: '#111',
  });
  const adminBlock = db.seed('scheduleBlock', {
    id: 'sb-admin',
    userId: ADMIN,
    title: 'Admin focus',
    dayOfWeek: 1,
  });

  const tasks = {
    adminProject: db.seed('task', {
      id: 't-admin-project',
      title: 'Admin project task',
      userId: ADMIN,
      projectId: project.id,
      goalId: adminGoal.id,
      scheduleBlockId: adminBlock.id,
      status: 'TODO',
    }),
    memberProject: db.seed('task', {
      id: 't-member-project',
      title: 'Member project task',
      userId: MEMBER,
      projectId: project.id,
      status: 'TODO',
    }),
    member2Project: db.seed('task', {
      id: 't-member2-project',
      title: 'Member2 project task',
      userId: MEMBER2,
      projectId: project.id,
      assigneeId: MEMBER,
      status: 'DOING',
    }),
    adminPersonal: db.seed('task', {
      id: 't-admin-personal',
      title: 'Admin personal',
      userId: ADMIN,
    }),
    memberPersonal: db.seed('task', {
      id: 't-member-personal',
      title: 'Member personal',
      userId: MEMBER,
    }),
    outsiderPersonal: db.seed('task', {
      id: 't-outsider-personal',
      title: 'Outsider personal',
      userId: OUTSIDER,
    }),
  };

  const prisma = db.client;
  const tasksService = new TasksService(prisma, auth as any, goals as any);
  const timeEntries = new TimeEntriesService(prisma, auth as any, goals as any);
  const timer = new ActiveTimerService(prisma, auth as any, goals as any);
  const projects = new ProjectsService(prisma);
  const invites = new ProjectInvitesService(prisma, email as any);

  return {
    db,
    prisma,
    goals,
    auth,
    email,
    project,
    tasks,
    adminGoal,
    memberGoal,
    adminBlock,
    tasksService,
    timeEntries,
    timer,
    projects,
    invites,
  };
}

export type World = ReturnType<typeof buildWorld>;

/** Resolves to 'ok', or the HTTP status of the Nest exception thrown. */
export async function outcome(
  fn: () => Promise<unknown>,
): Promise<'ok' | number> {
  try {
    await fn();
    return 'ok';
  } catch (error: any) {
    if (typeof error?.getStatus === 'function') return error.getStatus();
    throw error;
  }
}
