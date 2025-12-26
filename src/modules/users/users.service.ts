import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { 
  UpdateUserDto, 
  CreateInternalUserDto,
  AdminToggleUserStatusDto,
  AdminAssignPlanDto,
  AdminSetEmailVerifiedDto,
} from './dto/users.dto';
import { UserRole, UserType, PlanType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

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
    const user = await this.prisma.user.findUnique({
      where: { id },
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
        emailVerified: true,
        isDisabled: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async updateProfile(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        avatar: dto.avatar,
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        role: true,
        userType: true,
        plan: true,
      },
    });
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
}
