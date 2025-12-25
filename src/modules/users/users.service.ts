import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserDto, CreateInternalUserDto } from './dto/users.dto';
import { UserRole, UserType, PlanType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

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
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || (admin.role !== UserRole.SUPER_ADMIN && admin.role !== UserRole.ADMIN)) {
      throw new ForbiddenException('Only admins can create internal users');
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
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        userType: true,
        plan: true,
      },
    });
  }

  // Admin: Grant free access to external user
  async grantFreeAccess(adminId: string, userId: string) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || (admin.role !== UserRole.SUPER_ADMIN && admin.role !== UserRole.ADMIN)) {
      throw new ForbiddenException('Only admins can grant free access');
    }

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
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || (admin.role !== UserRole.SUPER_ADMIN && admin.role !== UserRole.ADMIN)) {
      throw new ForbiddenException('Only admins can revoke access');
    }

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
        plan: user.subscriptionStatus === 'active' ? PlanType.PRO : PlanType.FREE,
      },
    });
  }

  // Admin: List all users
  async listUsers(adminId: string, page = 1, limit = 20) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || (admin.role !== UserRole.SUPER_ADMIN && admin.role !== UserRole.ADMIN)) {
      throw new ForbiddenException('Only admins can list users');
    }

    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          userType: true,
          plan: true,
          unlimitedAccess: true,
          subscriptionStatus: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count(),
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

  // Super Admin: Promote user to admin
  async promoteToAdmin(superAdminId: string, userId: string) {
    const superAdmin = await this.prisma.user.findUnique({ where: { id: superAdminId } });
    if (!superAdmin || superAdmin.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admin can promote users');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.ADMIN },
    });
  }
}
