import { Injectable, UnauthorizedException, ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseService } from '../../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { RegisterDto, LoginDto, SSOLoginDto } from './dto/auth.dto';
import { UserRole, UserType, PlanType } from '@prisma/client';

// Plan limits
export const PLAN_LIMITS = {
  FREE: {
    maxGoals: 3,
    maxSchedules: 5,
    maxTasksPerDay: 3,
  },
  PRO: {
    maxGoals: Infinity,
    maxSchedules: Infinity,
    maxTasksPerDay: Infinity,
  },
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private supabaseService: SupabaseService,
    private usersService: UsersService,
  ) {}

  async register(dto: RegisterDto) {
    // Check if user exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(dto.password, 10);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        name: dto.name,
        role: UserRole.USER,
        userType: UserType.EXTERNAL,
        plan: PlanType.FREE,
      },
    });

    // Seed default categories for new user
    await this.seedDefaultCategories(user.id);

    // Generate tokens
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async ssoLogin(dto: SSOLoginDto) {
    // Verify SSO token from DevWeekends platform
    const ssoResult = await this.supabaseService.verifySSOToken(dto.token);

    if (!ssoResult.valid) {
      throw new UnauthorizedException('Invalid SSO token');
    }

    // Find or create user
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          { ssoId: ssoResult.user?.id, ssoProvider: 'devweekends' },
        ],
      },
    });

    if (!user) {
      // Create new user from SSO
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name || dto.email.split('@')[0],
          ssoProvider: 'devweekends',
          ssoId: ssoResult.user?.id,
          userType: UserType.INTERNAL, // DW users are internal
          plan: PlanType.PRO, // DW users get Pro for free
          unlimitedAccess: true,
        },
      });

      // Seed default categories for new user
      await this.seedDefaultCategories(user.id);
    } else if (!user.ssoId) {
      // Link existing account to SSO
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ssoProvider: 'devweekends',
          ssoId: ssoResult.user?.id,
          userType: UserType.INTERNAL,
          plan: PlanType.PRO,
          unlimitedAccess: true,
        },
      });
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.sanitizeUser(user);
  }

  async refreshToken(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.generateTokens(user.id, user.email, user.role);
  }

  private async generateTokens(userId: string, email: string, role: UserRole) {
    const payload = { sub: userId, email, role };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '30d' });

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: any) {
    const { password, ...sanitized } = user;
    return {
      ...sanitized,
      limits: this.getUserLimits(user),
    };
  }

  getUserLimits(user: any) {
    // Internal users or users with unlimitedAccess get Pro limits
    if (user.userType === UserType.INTERNAL || user.unlimitedAccess) {
      return PLAN_LIMITS.PRO;
    }

    // Check subscription status for external users
    if (user.plan === PlanType.PRO && user.subscriptionStatus === 'active') {
      return PLAN_LIMITS.PRO;
    }

    return PLAN_LIMITS.FREE;
  }

  async checkPlanLimit(userId: string, limitType: 'goals' | 'schedules' | 'tasksPerDay', currentCount: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ForbiddenException('User not found');

    const limits = this.getUserLimits(user);
    
    const limitMap = {
      goals: limits.maxGoals,
      schedules: limits.maxSchedules,
      tasksPerDay: limits.maxTasksPerDay,
    };

    if (currentCount >= limitMap[limitType]) {
      throw new ForbiddenException(
        `You've reached your ${user.plan} plan limit for ${limitType}. Upgrade to Pro for unlimited access.`
      );
    }

    return true;
  }

  private async seedDefaultCategories(userId: string) {
    const defaultCategories = [
      { name: 'Learning', value: 'LEARNING', color: '#3B82F6', order: 1 }, // blue-500
      { name: 'Work', value: 'WORK', color: '#22D3EE', order: 2 }, // cyan-400
      { name: 'Health', value: 'HEALTH', color: '#22C55E', order: 3 }, // green-500
      { name: 'Creative', value: 'CREATIVE', color: '#EC4899', order: 4 }, // pink-500
      { name: 'Deep Work', value: 'DEEP_WORK', color: '#FFD700', order: 5 }, // yellow/gold
      { name: 'Exercise', value: 'EXERCISE', color: '#F97316', order: 6 }, // orange-500
      { name: 'Side Project', value: 'SIDE_PROJECT', color: '#EC4899', order: 7 }, // pink-500
      { name: 'DSA', value: 'DSA', color: '#FFD700', order: 8 }, // yellow/gold
      { name: 'Meeting', value: 'MEETING', color: '#8B5CF6', order: 9 }, // purple-500
      { name: 'Admin', value: 'ADMIN', color: '#9CA3AF', order: 10 }, // gray-400
      { name: 'Break', value: 'BREAK', color: '#D1D5DB', order: 11 }, // gray-300
      { name: 'Other', value: 'OTHER', color: '#9CA3AF', order: 12 }, // gray-400
    ];

    // Check if user already has categories
    const existingCount = await this.prisma.category.count({
      where: { userId },
    });

    if (existingCount > 0) {
      return; // Already seeded
    }

    // Create default categories
    await Promise.all(
      defaultCategories.map((cat) =>
        this.prisma.category.create({
          data: {
            ...cat,
            userId,
            isDefault: true,
          },
        }),
      ),
    );
  }
}
