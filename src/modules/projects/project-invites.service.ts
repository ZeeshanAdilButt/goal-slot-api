import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import {
  CreateProjectInvitesDto,
  ProjectInviteLinkDto,
} from './dto/projects.dto';
import { assertProjectAccess, getProjectRole } from './project-access';
import { MAX_MEMBERS_PER_PROJECT } from './projects.service';

export const INVITE_TTL_DAYS = 7;
export const MAX_PENDING_EMAIL_INVITES = 30;

/** 256 bits from the CSPRNG, URL-safe. */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

function inviteExpiry(now = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Matches the web accept page (/projects/invite?token=...). */
function inviteLinkPath(token: string): string {
  return `/projects/invite?token=${encodeURIComponent(token)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

type InviteRow = {
  id: string;
  projectId: string;
  email: string | null;
  role: ProjectRole;
  token: string;
  expiresAt: Date;
  invitedById: string;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class ProjectInvitesService {
  private readonly logger = new Logger(ProjectInvitesService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  // -------------------------------------------------------------------
  // Admin side
  // -------------------------------------------------------------------

  /**
   * One invite per email. Existing members are skipped and reported; an
   * email that already has a pending invite gets a fresh token and expiry
   * (and the newly chosen role) instead of a duplicate row. Email delivery
   * failures do not fail the invite: the row exists and can be resent.
   */
  async createEmailInvites(
    userId: string,
    projectId: string,
    dto: CreateProjectInvitesDto,
  ) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    const role = dto.role ?? ProjectRole.MEMBER;
    const now = new Date();

    const emails = [
      ...new Set(dto.emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
    ];

    const [project, inviter, existingUsers] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      }),
      this.prisma.user.findMany({
        where: { email: { in: emails, mode: 'insensitive' } },
        select: { id: true, email: true },
      }),
    ]);
    if (!project) throw new NotFoundException('Project not found');

    const memberRows = existingUsers.length
      ? await this.prisma.projectMember.findMany({
          where: {
            projectId,
            userId: { in: existingUsers.map((u: any) => u.id) },
          },
          select: { userId: true },
        })
      : [];
    const memberIds = new Set(memberRows.map((m: any) => m.userId));
    const memberEmails = new Set(
      existingUsers
        .filter((u: any) => memberIds.has(u.id))
        .map((u: any) => String(u.email).toLowerCase()),
    );

    const skipped = emails
      .filter((e) => memberEmails.has(e))
      .map((email) => ({ email, reason: 'already_member' as const }));
    const toInvite = emails.filter((e) => !memberEmails.has(e));

    const pendingRows: InviteRow[] = toInvite.length
      ? await this.prisma.projectInvite.findMany({
          where: {
            projectId,
            email: { in: toInvite },
            acceptedAt: null,
            revokedAt: null,
          },
        })
      : [];
    const pendingByEmail = new Map<string, InviteRow>();
    for (const row of pendingRows) {
      if (row.email) pendingByEmail.set(row.email, row);
    }

    // Cap counts live (unexpired) pending email invites. Refreshing an
    // invite that is already live does not add to it.
    const addsToPending = toInvite.filter((e) => {
      const row = pendingByEmail.get(e);
      return !row || row.expiresAt <= now;
    }).length;
    if (addsToPending > 0) {
      const livePending = await this.prisma.projectInvite.count({
        where: {
          projectId,
          email: { not: null },
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (livePending + addsToPending > MAX_PENDING_EMAIL_INVITES) {
        throw new BadRequestException(
          `A project can have at most ${MAX_PENDING_EMAIL_INVITES} pending email invites`,
        );
      }
    }

    const invited: Array<{
      id: string;
      email: string;
      role: ProjectRole;
      expiresAt: Date;
      emailSent: boolean;
    }> = [];

    for (const email of toInvite) {
      const token = newInviteToken();
      const expiresAt = inviteExpiry(now);
      const existing = pendingByEmail.get(email);
      const row: InviteRow = existing
        ? await this.prisma.projectInvite.update({
            where: { id: existing.id },
            data: { token, expiresAt, role, invitedById: userId },
          })
        : await this.prisma.projectInvite.create({
            data: {
              projectId,
              email,
              role,
              token,
              expiresAt,
              invitedById: userId,
            },
          });

      const emailSent = await this.sendInviteEmail({
        toEmail: email,
        inviterName: inviter?.name ?? 'A teammate',
        inviterEmail: inviter?.email ?? '',
        projectName: project.name,
        role,
        token,
      });

      invited.push({
        id: row.id,
        email,
        role: row.role,
        expiresAt: row.expiresAt,
        emailSent,
      });
    }

    return { invited, skipped };
  }

  /** Pending email invites (not accepted, not revoked), newest first. */
  async list(userId: string, projectId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    const now = new Date();
    const rows = await this.prisma.projectInvite.findMany({
      where: {
        projectId,
        email: { not: null },
        acceptedAt: null,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: { invitedBy: { select: { id: true, name: true } } },
    });
    return rows.map((r: any) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      expiresAt: r.expiresAt,
      expired: r.expiresAt <= now,
      createdAt: r.createdAt,
      invitedBy: r.invitedBy ?? null,
    }));
  }

  async resend(userId: string, projectId: string, inviteId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    const invite: InviteRow | null = await this.prisma.projectInvite.findFirst({
      where: { id: inviteId, projectId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (!invite.email) {
      throw new BadRequestException('Link invites cannot be resent');
    }
    if (invite.acceptedAt || invite.revokedAt) {
      throw new BadRequestException('This invite is no longer pending');
    }

    const [project, inviter] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      }),
    ]);

    const token = newInviteToken();
    const updated: InviteRow = await this.prisma.projectInvite.update({
      where: { id: invite.id },
      data: { token, expiresAt: inviteExpiry(), invitedById: userId },
    });

    const emailSent = await this.sendInviteEmail({
      toEmail: invite.email,
      inviterName: inviter?.name ?? 'A teammate',
      inviterEmail: inviter?.email ?? '',
      projectName: project?.name ?? '',
      role: updated.role,
      token,
    });

    return {
      id: updated.id,
      email: updated.email,
      role: updated.role,
      expiresAt: updated.expiresAt,
      emailSent,
    };
  }

  async revoke(userId: string, projectId: string, inviteId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    const invite = await this.prisma.projectInvite.findFirst({
      where: { id: inviteId, projectId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (!invite.revokedAt) {
      await this.prisma.projectInvite.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() },
      });
    }
    return { message: 'Invite revoked' };
  }

  /**
   * The project's shareable link: email null, multi-use, 7 days. Returns
   * the live one when there is one (switching its role if a different one
   * is asked for), otherwise creates it.
   */
  async getOrCreateLink(
    userId: string,
    projectId: string,
    dto: ProjectInviteLinkDto,
  ) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    const now = new Date();

    let link: InviteRow | null = await this.prisma.projectInvite.findFirst({
      where: {
        projectId,
        email: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (link && dto.role && link.role !== dto.role) {
      link = await this.prisma.projectInvite.update({
        where: { id: link.id },
        data: { role: dto.role },
      });
    }

    if (!link) {
      link = await this.prisma.projectInvite.create({
        data: {
          projectId,
          email: null,
          role: dto.role ?? ProjectRole.MEMBER,
          token: newInviteToken(),
          expiresAt: inviteExpiry(now),
          invitedById: userId,
        },
      });
    }

    return {
      id: link!.id,
      token: link!.token,
      role: link!.role,
      expiresAt: link!.expiresAt,
      inviteLink: inviteLinkPath(link!.token),
    };
  }

  async revokeLink(userId: string, projectId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'admin');
    const { count } = await this.prisma.projectInvite.updateMany({
      where: { projectId, email: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: count };
  }

  // -------------------------------------------------------------------
  // Recipient side (any signed-in user holding the token)
  // -------------------------------------------------------------------

  private async findByToken(token: string) {
    const invite = await this.prisma.projectInvite.findUnique({
      where: { token },
      include: {
        project: { select: { id: true, name: true, color: true } },
        invitedBy: { select: { name: true } },
      },
    });
    if (!invite) throw new NotFoundException('Invitation not found');
    return invite as InviteRow & {
      project: { id: string; name: string; color: string };
      invitedBy: { name: string } | null;
    };
  }

  /**
   * What the accept page shows. `expired` means "cannot be accepted any
   * more": past its expiry, revoked, or an email invite already used.
   */
  async preview(userId: string, token: string) {
    const invite = await this.findByToken(token);
    const alreadyMember = !!(await getProjectRole(
      this.prisma,
      userId,
      invite.projectId,
    ));
    const revoked = !!invite.revokedAt;
    const used = !!invite.email && !!invite.acceptedAt;

    let emailMatches: boolean | null = null;
    if (invite.email) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      emailMatches =
        !!user && user.email.toLowerCase() === invite.email.toLowerCase();
    }

    return {
      projectId: invite.projectId,
      projectName: invite.project.name,
      color: invite.project.color,
      inviterName: invite.invitedBy?.name ?? null,
      role: invite.role,
      expired: invite.expiresAt <= new Date() || revoked || used,
      revoked,
      alreadyMember,
      emailMatches,
    };
  }

  /**
   * Accept rules (spec): already a member is idempotent; revoked or expired
   * is 410; an email invite needs the signed-in email to match
   * (case-insensitive) and is single use; a link invite accepts for anyone
   * signed in.
   */
  async accept(userId: string, token: string) {
    const invite = await this.findByToken(token);
    const projectId = invite.projectId;

    const existing = await getProjectRole(this.prisma, userId, projectId);
    if (existing) {
      return { projectId, role: existing, alreadyMember: true };
    }

    if (invite.revokedAt) {
      throw new GoneException('This invitation was revoked');
    }
    if (invite.expiresAt <= new Date()) {
      throw new GoneException('This invitation has expired');
    }

    if (invite.email) {
      if (invite.acceptedAt) {
        throw new GoneException('This invitation has already been used');
      }
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new ForbiddenException(
          'This invitation was sent to a different email address. Sign in with the invited email to accept it.',
        );
      }
    }

    const members = await this.prisma.projectMember.count({
      where: { projectId },
    });
    if (members >= MAX_MEMBERS_PER_PROJECT) {
      throw new ConflictException(
        `This project already has ${MAX_MEMBERS_PER_PROJECT} members`,
      );
    }

    try {
      const ops: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.projectMember.create({
          data: { projectId, userId, role: invite.role },
        }),
      ];
      if (invite.email) {
        ops.push(
          this.prisma.projectInvite.update({
            where: { id: invite.id },
            data: { acceptedAt: new Date() },
          }),
        );
      }
      await this.prisma.$transaction(ops);
    } catch (error) {
      // A double-click raced us to the membership row: same outcome.
      if (!isUniqueViolation(error)) throw error;
      const role = await getProjectRole(this.prisma, userId, projectId);
      return { projectId, role, alreadyMember: true };
    }

    return { projectId, role: invite.role, alreadyMember: false };
  }

  private async sendInviteEmail(args: {
    toEmail: string;
    inviterName: string;
    inviterEmail: string;
    projectName: string;
    role: ProjectRole;
    token: string;
  }): Promise<boolean> {
    try {
      await this.emailService.sendProjectInvitation({
        toEmail: args.toEmail,
        inviterName: args.inviterName,
        inviterEmail: args.inviterEmail,
        projectName: args.projectName,
        role: args.role,
        inviteToken: args.token,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Address deliberately omitted (see SharingService.inviteUser).
      this.logger.error(`Failed to send project invitation email: ${message}`);
      return false;
    }
  }
}
