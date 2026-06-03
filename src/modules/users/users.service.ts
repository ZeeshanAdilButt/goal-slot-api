import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import {
  UpdateUserDto,
  CreateInternalUserDto,
  AdminToggleUserStatusDto,
  AdminAssignPlanDto,
  AdminBulkAssignPlanDto,
  AdminSetEmailVerifiedDto,
} from './dto/users.dto';
import { BulkInviteDto, BulkInviteRow, BulkInviteResponse } from './dto/bulk-invite.dto';
import { UserRole, UserType, PlanType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { resolvePlanLimits } from '../auth/plan-limits';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  private sanitizeUser(user: any) {
    const { password, ...rest } = user;
    return {
      ...rest,
      limits: resolvePlanLimits(user),
    };
  }

  // Helper to check if user is admin
  private async verifyAdmin(adminId: string, requireSuperAdmin = false) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (!admin) {
      throw new ForbiddenException('Admin not found');
    }
    if (requireSuperAdmin && admin.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admin can perform this action');
    }
    if (!requireSuperAdmin && admin.role !== UserRole.SUPER_ADMIN && admin.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can perform this action');
    }
    return admin;
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.sanitizeUser(user);
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async updateProfile(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        avatar: dto.avatar,
      },
    });

    return this.sanitizeUser(updatedUser);
  }

  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Hard delete user - cascade will delete all related data
    // (goals, tasks, time entries, journal entries, notes, etc.)
    await this.prisma.user.delete({
      where: { id: userId },
    });

    return { success: true };
  }

  // Admin: Create internal user
  async createInternalUser(adminId: string, dto: CreateInternalUserDto) {
    await this.verifyAdmin(adminId);

    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existingUser) {
      throw new BadRequestException('User with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    return this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        name: dto.name,
        role: dto.role || UserRole.USER,
        userType: UserType.INTERNAL,
        plan: PlanType.PRO,
        unlimitedAccess: true,
        emailVerified: true, // Internal users are auto-verified
        emailVerifiedAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        userType: true,
        plan: true,
        emailVerified: true,
      },
    });
  }

  // Admin: Grant free access to external user
  async grantFreeAccess(adminId: string, userId: string) {
    await this.verifyAdmin(adminId);

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        unlimitedAccess: true,
        plan: PlanType.PRO,
      },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        unlimitedAccess: true,
      },
    });
  }

  // Admin: Revoke free access
  async revokeFreeAccess(adminId: string, userId: string) {
    await this.verifyAdmin(adminId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Don't revoke from internal users
    if (user.userType === UserType.INTERNAL) {
      throw new ForbiddenException('Cannot revoke access from internal users');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        unlimitedAccess: false,
        plan: user.subscriptionStatus === 'active' ? user.plan : PlanType.FREE,
        adminAssignedPlan: null,
        adminAssignedPlanAt: null,
        adminAssignedPlanBy: null,
        adminAssignedPlanNote: null,
      },
    });
  }

  // Admin: List all users with extended info
  async listUsers(adminId: string, page = 1, limit = 20, search?: string) {
    await this.verifyAdmin(adminId);

    const skip = (page - 1) * limit;

    const whereClause = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          avatar: true,
          role: true,
          userType: true,
          plan: true,
          unlimitedAccess: true,
          subscriptionStatus: true,
          subscriptionEndDate: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          firstPaymentDate: true,
          lastPaymentDate: true,
          invoicePending: true,
          lastInvoiceId: true,
          isDisabled: true,
          disabledAt: true,
          disabledReason: true,
          emailVerified: true,
          emailVerifiedAt: true,
          adminAssignedPlan: true,
          adminAssignedPlanAt: true,
          adminAssignedPlanBy: true,
          adminAssignedPlanNote: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.user.count({ where: whereClause }),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // Admin: Get single user details
  async getUserDetails(adminId: string, userId: string) {
    await this.verifyAdmin(adminId);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        role: true,
        userType: true,
        plan: true,
        unlimitedAccess: true,
        subscriptionStatus: true,
        subscriptionEndDate: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        isDisabled: true,
        disabledAt: true,
        disabledReason: true,
        emailVerified: true,
        emailVerifiedAt: true,
        adminAssignedPlan: true,
        adminAssignedPlanAt: true,
        adminAssignedPlanBy: true,
        adminAssignedPlanNote: true,
        firstPaymentDate: true,
        lastPaymentDate: true,
        invoicePending: true,
        lastInvoiceId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            goals: true,
            timeEntries: true,
            tasks: true,
            notes: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  // Super Admin: Promote user to admin
  async promoteToAdmin(superAdminId: string, userId: string) {
    await this.verifyAdmin(superAdminId, true);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot modify super admin role');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.ADMIN },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    });
  }

  // Super Admin: Demote user from admin
  async demoteFromAdmin(superAdminId: string, userId: string) {
    await this.verifyAdmin(superAdminId, true);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot demote super admin');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new BadRequestException('User is not an admin');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.USER },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    });
  }

  // Admin: Toggle user disabled status
  async toggleUserStatus(adminId: string, userId: string, dto: AdminToggleUserStatusDto) {
    await this.verifyAdmin(adminId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Prevent disabling admins unless you're super admin
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (user.role === UserRole.ADMIN && admin?.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admin can disable other admins');
    }

    // Prevent disabling super admin
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot disable super admin');
    }

    // Require reason when disabling
    if (dto.isDisabled && !dto.reason) {
      throw new BadRequestException('Reason is required when disabling a user');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        isDisabled: dto.isDisabled,
        disabledAt: dto.isDisabled ? new Date() : null,
        disabledReason: dto.isDisabled ? dto.reason : null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        isDisabled: true,
        disabledAt: true,
        disabledReason: true,
      },
    });
  }

  // Admin: Assign plan to user
  async assignPlan(adminId: string, userId: string, dto: AdminAssignPlanDto) {
    const admin = await this.verifyAdmin(adminId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Internal users always have PRO
    if (user.userType === UserType.INTERNAL && dto.plan !== PlanType.PRO) {
      throw new ForbiddenException('Internal users must remain on PRO plan');
    }

    const updateData: any = {
      plan: dto.plan,
      adminAssignedPlan: dto.plan,
      adminAssignedPlanAt: new Date(),
      adminAssignedPlanBy: adminId,
      adminAssignedPlanNote: dto.note || null,
    };

    // If assigning PRO, also grant unlimited access
    if (dto.plan === PlanType.PRO) {
      updateData.unlimitedAccess = true;
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        adminAssignedPlan: true,
        adminAssignedPlanAt: true,
        adminAssignedPlanNote: true,
        unlimitedAccess: true,
      },
    });
  }

  // Admin: Bulk assign plan to users
  async bulkAssignPlan(adminId: string, dto: AdminBulkAssignPlanDto) {
    const admin = await this.verifyAdmin(adminId);

    // Validate no internal users are being downgraded
    if (dto.plan !== PlanType.PRO) {
      const internalUsers = await this.prisma.user.findMany({
        where: { 
          id: { in: dto.userIds },
          userType: UserType.INTERNAL 
        }
      });
      
      if (internalUsers.length > 0) {
        throw new ForbiddenException(`Cannot downgrade internal users: ${internalUsers.map(u => u.email).join(', ')}`);
      }
    }

    const updateData: any = {
      plan: dto.plan,
      adminAssignedPlan: dto.plan,
      adminAssignedPlanAt: new Date(),
      adminAssignedPlanBy: adminId,
      adminAssignedPlanNote: dto.note || null,
    };

    // If assigning PRO, also grant unlimited access
    if (dto.plan === PlanType.PRO) {
      updateData.unlimitedAccess = true;
    }

    const result = await this.prisma.user.updateMany({
      where: { id: { in: dto.userIds } },
      data: updateData,
    });

    return { updatedCount: result.count };
  }

  // Admin: Set email verification status
  async setEmailVerified(adminId: string, userId: string, dto: AdminSetEmailVerifiedDto) {
    await this.verifyAdmin(adminId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerified: dto.emailVerified,
        emailVerifiedAt: dto.emailVerified ? new Date() : null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        emailVerifiedAt: true,
      },
    });
  }

  // Admin: Get user statistics
  async getUserStats(adminId: string) {
    await this.verifyAdmin(adminId);

    const [totalUsers, activeUsers, disabledUsers, verifiedUsers, planCounts] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isDisabled: false } }),
      this.prisma.user.count({ where: { isDisabled: true } }),
      this.prisma.user.count({ where: { emailVerified: true } }),
      this.prisma.user.groupBy({
        by: ['plan'],
        _count: { plan: true },
      }),
    ]);

    const planCountsMap = planCounts.reduce((acc, curr) => {
      acc[curr.plan] = curr._count.plan;
      return acc;
    }, {} as Record<string, number>);

    return {
      totalUsers,
      activeUsers,
      disabledUsers,
      verifiedUsers,
      unverifiedUsers: totalUsers - verifiedUsers,
      byPlan: {
        free: planCountsMap[PlanType.FREE] || 0,
        basic: planCountsMap[PlanType.BASIC] || 0,
        pro: planCountsMap[PlanType.PRO] || 0,
      },
    };
  }

  // ============================================================
  // Bulk invite
  // ============================================================

  // Permissive email parser that handles whatever the admin pastes:
  // commas, spaces, newlines, semicolons, angle brackets, or even
  // "Name <email@example.com>" formats. Deduped case-insensitively.
  // Anything that doesn't look like a valid email is dropped to the
  // invalid pile and surfaced in the response.
  private parseEmails(text: string): { valid: string[]; invalid: string[] } {
    // Split on any non-email-char boundary
    const tokens = text
      .split(/[\s,;<>()\[\]"'\\]+/u)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const valid = new Set<string>();
    const invalid: string[] = [];
    // Conservative RFC-lite email regex. Good enough for cohort imports;
    // edge cases (quoted locals, plus-addressing inside subdomains) are
    // not worth the false-positive risk for an admin tool.
    const emailRe = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
    for (const t of tokens) {
      if (emailRe.test(t)) {
        valid.add(t);
      } else if (t.includes('@')) {
        // Looked like an email but failed validation. Surface it so
        // the admin can fix typos rather than silently dropping.
        invalid.push(t);
      }
    }
    return { valid: Array.from(valid), invalid };
  }

  async bulkInvite(adminId: string, dto: BulkInviteDto): Promise<BulkInviteResponse> {
    await this.verifyAdmin(adminId);

    const inviter = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { name: true, email: true },
    });
    if (!inviter) {
      throw new NotFoundException('Inviter not found');
    }

    const { valid, invalid } = this.parseEmails(dto.text);
    const targetRole = dto.role || UserRole.USER;

    const rows: BulkInviteRow[] = invalid.map((email) => ({
      email,
      status: 'invalid',
      reason: 'Not a valid email address',
    }));

    if (valid.length === 0) {
      return {
        total: invalid.length,
        invited: 0,
        alreadyUsers: 0,
        invalid: invalid.length,
        failed: 0,
        rows,
      };
    }

    // Single query to find which emails already have accounts; saves N
    // round trips on big batches.
    const existing = await this.prisma.user.findMany({
      where: { email: { in: valid } },
      select: { email: true },
    });
    const existingSet = new Set(existing.map((u) => u.email.toLowerCase()));

    for (const email of valid) {
      if (existingSet.has(email)) {
        rows.push({
          email,
          status: 'already_user',
          reason: 'An account with this email already exists',
        });
        continue;
      }

      try {
        // Pre-create the account with a long random password that the
        // invitee will replace via the forgot-password flow on first
        // visit. We mark them email-verified because the admin has
        // vouched, and grant unlimited PRO access (fellowship pattern).
        const tempPassword = randomBytes(24).toString('base64url');
        const hashed = await bcrypt.hash(tempPassword, 10);
        const namePrefix = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

        const created = await this.prisma.user.create({
          data: {
            email,
            password: hashed,
            name: namePrefix || 'Member',
            role: targetRole,
            userType: UserType.INTERNAL,
            plan: PlanType.PRO,
            unlimitedAccess: true,
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
          select: { id: true },
        });

        // Best-effort email. Don't fail the whole row if Resend hiccups;
        // the account still exists and the admin can resend the email
        // separately.
        try {
          await this.emailService.sendBulkInviteWelcome({
            toEmail: email,
            inviterName: inviter.name,
            inviterEmail: inviter.email,
            role: targetRole,
          });
        } catch (err) {
          this.logger.error(
            `Bulk invite created account ${created.id} but email failed for ${email}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        rows.push({
          email,
          status: 'invited',
          userId: created.id,
        });
      } catch (err) {
        this.logger.error(
          `Bulk invite failed for ${email}: ${err instanceof Error ? err.message : String(err)}`,
        );
        rows.push({
          email,
          status: 'failed',
          reason: err instanceof Error ? err.message : 'Unknown failure creating the account',
        });
      }
    }

    return {
      total: rows.length,
      invited: rows.filter((r) => r.status === 'invited').length,
      alreadyUsers: rows.filter((r) => r.status === 'already_user').length,
      invalid: rows.filter((r) => r.status === 'invalid').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      rows,
    };
  }
}
