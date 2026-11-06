import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProjectRole, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateProjectDto,
  UpdateMemberRoleDto,
  UpdateProjectDto,
} from './dto/projects.dto';
import { assertProjectAccess } from './project-access';

export const MAX_PROJECTS_CREATED_PER_USER = 50;
export const MAX_MEMBERS_PER_PROJECT = 50;

const PROJECT_COUNTS = {
  _count: {
    select: {
      members: true,
      tasks: { where: { status: { not: TaskStatus.DONE } } },
    },
  },
} as const;

type ProjectWithCounts = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  createdById: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { members?: number; tasks?: number };
};

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  private toDetail(project: ProjectWithCounts, role: ProjectRole) {
    const { _count, ...rest } = project;
    return {
      ...rest,
      role,
      memberCount: _count?.members ?? 0,
      openTaskCount: _count?.tasks ?? 0,
    };
  }

  async create(userId: string, dto: CreateProjectDto) {
    const created = await this.prisma.project.count({
      where: { createdById: userId },
    });
    if (created >= MAX_PROJECTS_CREATED_PER_USER) {
      throw new BadRequestException(
        `You can create up to ${MAX_PROJECTS_CREATED_PER_USER} projects`,
      );
    }

    // The creator's ADMIN membership is written in the same statement as the
    // project, so there is never a project without an admin.
    const project = await this.prisma.project.create({
      data: {
        name: dto.name,
        color: dto.color,
        description: dto.description,
        createdById: userId,
        members: { create: { userId, role: ProjectRole.ADMIN } },
      },
    });

    return this.toDetail(
      { ...project, _count: { members: 1, tasks: 0 } },
      ProjectRole.ADMIN,
    );
  }

  /** Projects I belong to, archived ones left out. */
  async list(userId: string) {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId, project: { archivedAt: null } },
      orderBy: { joinedAt: 'asc' },
      include: { project: { include: PROJECT_COUNTS } },
    });

    return memberships.map((m: any) => ({
      id: m.project.id,
      name: m.project.name,
      color: m.project.color,
      role: m.role as ProjectRole,
      memberCount: m.project._count?.members ?? 0,
      openTaskCount: m.project._count?.tasks ?? 0,
    }));
  }

  async findOne(userId: string, projectId: string) {
    const role = await assertProjectAccess(
      this.prisma,
      userId,
      projectId,
      'read',
    );
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: PROJECT_COUNTS,
    });
    if (!project) throw new NotFoundException('Project not found');
    return this.toDetail(project as ProjectWithCounts, role);
  }

  async update(userId: string, projectId: string, dto: UpdateProjectDto) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.archived !== undefined) {
      data.archivedAt = dto.archived ? new Date() : null;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.project.update({ where: { id: projectId }, data });
    }
    return this.findOne(userId, projectId);
  }

  /** Tasks, members and invites cascade; TimeEntry.taskId is SetNull. */
  async remove(userId: string, projectId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    await this.prisma.project.delete({ where: { id: projectId } });
    return { message: 'Project deleted' };
  }

  async listMembers(userId: string, projectId: string) {
    const role = await assertProjectAccess(
      this.prisma,
      userId,
      projectId,
      'read',
    );
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { joinedAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });

    // Email addresses are only shown to admins (they manage invites);
    // everyone else sees name and avatar.
    const showEmail = role === ProjectRole.ADMIN;
    return members.map((m: any) => ({
      userId: m.userId,
      name: m.user?.name ?? '',
      email: showEmail ? (m.user?.email ?? null) : null,
      avatar: m.user?.avatar ?? null,
      role: m.role as ProjectRole,
      joinedAt: m.joinedAt,
    }));
  }

  private async requireMember(projectId: string, userId: string) {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  private async assertNotLastAdmin(projectId: string, message: string) {
    const admins = await this.prisma.projectMember.count({
      where: { projectId, role: ProjectRole.ADMIN },
    });
    if (admins <= 1) throw new ConflictException(message);
  }

  async updateMemberRole(
    userId: string,
    projectId: string,
    targetUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    const target = await this.requireMember(projectId, targetUserId);

    if (target.role === dto.role) {
      return { userId: targetUserId, role: target.role };
    }
    if (target.role === ProjectRole.ADMIN) {
      await this.assertNotLastAdmin(
        projectId,
        'A project needs at least one admin. Make someone else an admin first.',
      );
    }

    const updated = await this.prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: targetUserId } },
      data: { role: dto.role },
    });
    return { userId: targetUserId, role: updated.role };
  }

  /**
   * Remove a member (ADMIN) or leave (anyone, on themselves). Either way the
   * leaver's assigned tasks in this project are unassigned in the same
   * transaction, so nothing stays assigned to a non-member.
   */
  async removeMember(userId: string, projectId: string, targetUserId: string) {
    const role = await assertProjectAccess(
      this.prisma,
      userId,
      projectId,
      'read',
    );
    const leaving = targetUserId === userId;
    if (!leaving && role !== ProjectRole.ADMIN) {
      throw new ForbiddenException('Only project admins can remove members');
    }

    const target = await this.requireMember(projectId, targetUserId);
    if (target.role === ProjectRole.ADMIN) {
      await this.assertNotLastAdmin(
        projectId,
        leaving
          ? 'You are the last admin. Make someone else an admin before leaving.'
          : 'A project needs at least one admin.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.task.updateMany({
        where: { projectId, assigneeId: targetUserId },
        data: { assigneeId: null },
      }),
      this.prisma.projectMember.delete({
        where: { projectId_userId: { projectId, userId: targetUserId } },
      }),
    ]);

    return { message: leaving ? 'Left project' : 'Member removed' };
  }
}
