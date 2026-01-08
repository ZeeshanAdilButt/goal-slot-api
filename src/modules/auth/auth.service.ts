import { Injectable, UnauthorizedException, ConflictException, ForbiddenException, BadRequestException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseService } from '../../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { EmailService } from '../email/email.service';
import { RegisterDto, LoginDto, SSOLoginDto, SendOTPDto, VerifyOTPDto, ForgotPasswordDto, ResetPasswordDto, OTPPurpose, SendChangePasswordOTPDto, ChangePasswordDto } from './dto/auth.dto';
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

// OTP constants
const OTP_EXPIRY = 300; // 5 minutes in seconds
const OTP_RESEND_COOLDOWN = 60; // 60 seconds
const MAX_OTP_REQUESTS_PER_HOUR = 5;
const MAX_OTP_VERIFICATION_ATTEMPTS = 5; // Max failed attempts before lockout
const OTP_VERIFICATION_LOCKOUT_DURATION = 900000; // 15 minutes in milliseconds

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private supabaseService: SupabaseService,
    private usersService: UsersService,
    private emailService: EmailService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  // OTP Helper Methods
  private generateOTP(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private getRateLimitKey(email: string, purpose: OTPPurpose): string {
    return `otp:rate:${email}:${purpose}`;
  }

  private getOTPKey(email: string, purpose: OTPPurpose): string {
    return `otp:${email}:${purpose}`;
  }

  private getResendCooldownKey(email: string, purpose: OTPPurpose): string {
    return `otp:cooldown:${email}:${purpose}`;
  }

  private async checkRateLimit(email: string, purpose: OTPPurpose): Promise<void> {
    const key = this.getRateLimitKey(email, purpose);
    const count = await this.cacheManager.get<number>(key) || 0;
    
    if (count >= MAX_OTP_REQUESTS_PER_HOUR) {
      throw new BadRequestException('Too many OTP requests. Please wait before requesting another code.');
    }
    
    // Increment counter with 1 hour TTL
    await this.cacheManager.set(key, count + 1, 3600000); // 3600000ms = 1 hour
  }

  private async checkResendCooldown(email: string, purpose: OTPPurpose): Promise<void> {
    const key = this.getResendCooldownKey(email, purpose);
    const cooldown = await this.cacheManager.get<boolean>(key);
    
    if (cooldown) {
      throw new BadRequestException('Please wait 60 seconds before requesting a new code.');
    }
  }

  private getVerificationAttemptsKey(email: string, purpose: OTPPurpose): string {
    return `otp:attempts:${email}:${purpose}`;
  }

  private getVerificationLockoutKey(email: string, purpose: OTPPurpose): string {
    return `otp:lockout:${email}:${purpose}`;
  }

  private async checkVerificationLockout(email: string, purpose: OTPPurpose): Promise<void> {
    const key = this.getVerificationLockoutKey(email, purpose);
    const isLockedOut = await this.cacheManager.get<boolean>(key);
    
    if (isLockedOut) {
      throw new BadRequestException('Too many failed attempts. Your account is temporarily locked. Please try again in 15 minutes.');
    }
  }

  private async incrementVerificationAttempts(email: string, purpose: OTPPurpose): Promise<void> {
    const attemptsKey = this.getVerificationAttemptsKey(email, purpose);
    const attempts = await this.cacheManager.get<number>(attemptsKey) || 0;
    const newAttempts = attempts + 1;

    if (newAttempts >= MAX_OTP_VERIFICATION_ATTEMPTS) {
      // Lock out the user
      const lockoutKey = this.getVerificationLockoutKey(email, purpose);
      await this.cacheManager.set(lockoutKey, true, OTP_VERIFICATION_LOCKOUT_DURATION);
      // Clear attempts counter
      await this.cacheManager.del(attemptsKey);
      throw new BadRequestException('Too many failed attempts. Your account is temporarily locked. Please try again in 15 minutes.');
    }

    // Increment attempts with 15 minute TTL
    await this.cacheManager.set(attemptsKey, newAttempts, OTP_VERIFICATION_LOCKOUT_DURATION);
  }

  private async resetVerificationAttempts(email: string, purpose: OTPPurpose): Promise<void> {
    const attemptsKey = this.getVerificationAttemptsKey(email, purpose);
    await this.cacheManager.del(attemptsKey);
  }

  // Public OTP Methods
  async sendOTP(dto: SendOTPDto) {
    const { email, purpose } = dto;

    await this.checkRateLimit(email, purpose);
    await this.checkResendCooldown(email, purpose);

    
    if (purpose === OTPPurpose.SIGNUP) {
      const existingUser = await this.prisma.user.findUnique({
        where: { email },
      });
      
      if (existingUser) {
        throw new ConflictException('Email already registered');
      }
    }

    // For forgot password: validate user exists (silent fail for security)
    if (purpose === OTPPurpose.FORGOT_PASSWORD) {
      const user = await this.prisma.user.findUnique({
        where: { email },
      });
      
      // Silent fail - don't reveal if email exists or not
      if (!user) {
        return { success: true, message: 'If this email is registered, you will receive a verification code.' };
      }
    }

    
    const otp = this.generateOTP();
    const otpKey = this.getOTPKey(email, purpose);
    await this.cacheManager.set(otpKey, otp, OTP_EXPIRY * 1000); // Convert to milliseconds
    const cooldownKey = this.getResendCooldownKey(email, purpose);
    await this.cacheManager.set(cooldownKey, true, OTP_RESEND_COOLDOWN * 1000);

    // Send email
    await this.emailService.sendOTPEmail({
      toEmail: email,
      otp,
      purpose: purpose === OTPPurpose.SIGNUP ? 'signup' : 'forgot-password',
    });

    return { success: true, message: 'Verification code sent to your email.' };
  }

  async verifyOTP(dto: VerifyOTPDto): Promise<boolean> {
    const { email, otp, purpose } = dto;
    
    // Check if user is locked out due to too many failed attempts
    await this.checkVerificationLockout(email, purpose);
    
    const otpKey = this.getOTPKey(email, purpose);
    const storedOTP = await this.cacheManager.get<string>(otpKey);
    
    if (!storedOTP) {
      throw new BadRequestException('OTP not found or expired. Please request a new code.');
    }
    
    if (storedOTP !== otp) {
      // Increment failed attempts
      await this.incrementVerificationAttempts(email, purpose);
      throw new UnauthorizedException('Invalid OTP code. Please try again.');
    }
    
    // OTP is valid - reset attempts counter
    await this.resetVerificationAttempts(email, purpose);
    return true;
  }

  async checkEmailExists(email: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });
    return !!user;
  }

  async sendForgotPasswordOTP(dto: ForgotPasswordDto) {
    return this.sendOTP({
      email: dto.email,
      purpose: OTPPurpose.FORGOT_PASSWORD,
    });
  }

  async resetPassword(dto: ResetPasswordDto) {
    const { email, otp, newPassword } = dto;

    // Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    await this.verifyOTP({
      email,
      otp,
      purpose: OTPPurpose.FORGOT_PASSWORD,
    });
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    const otpKey = this.getOTPKey(email, OTPPurpose.FORGOT_PASSWORD);
    await this.cacheManager.del(otpKey);

    return { success: true, message: 'Password reset successfully.' };
  }

  async sendChangePasswordOTP(userId: string, currentPassword: string) {
    // Get user
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Check if user has a password (not SSO user)
    if (!user.password) {
      throw new BadRequestException('Password change is not available for SSO users');
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Send OTP
    await this.checkRateLimit(user.email, OTPPurpose.CHANGE_PASSWORD);
    await this.checkResendCooldown(user.email, OTPPurpose.CHANGE_PASSWORD);

    const otp = this.generateOTP();
    const otpKey = this.getOTPKey(user.email, OTPPurpose.CHANGE_PASSWORD);
    await this.cacheManager.set(otpKey, otp, OTP_EXPIRY * 1000);

    const cooldownKey = this.getResendCooldownKey(user.email, OTPPurpose.CHANGE_PASSWORD);
    await this.cacheManager.set(cooldownKey, true, OTP_RESEND_COOLDOWN * 1000);

    // Send email
    await this.emailService.sendOTPEmail({
      toEmail: user.email,
      otp,
      purpose: 'forgot-password', // Reuse forgot-password template
    });

    return { success: true, message: 'Verification code sent to your email.' };
  }

  async changePassword(userId: string, currentPassword: string, otp: string, newPassword: string) {
    // Get user
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Check if user has a password (not SSO user)
    if (!user.password) {
      throw new BadRequestException('Password change is not available for SSO users');
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Verify OTP
    await this.verifyOTP({
      email: user.email,
      otp,
      purpose: OTPPurpose.CHANGE_PASSWORD,
    });

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    try {
      // Update password
      await this.prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      });

      // Delete OTP after successful password change
      const otpKey = this.getOTPKey(user.email, OTPPurpose.CHANGE_PASSWORD);
      await this.cacheManager.del(otpKey);

      return { success: true, message: 'Password changed successfully.' };
    } catch (error) {
      throw new BadRequestException('Failed to change password. Please try again.');
    }
  }

  async register(dto: RegisterDto) {
    // Verify OTP first (does not delete it yet)
    await this.verifyOTP({
      email: dto.email,
      otp: dto.otp,
      purpose: OTPPurpose.SIGNUP,
    });

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(dto.password, 10);

    try {
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

      // Seed default labels for new user
      await this.seedDefaultLabels(user.id);

      // Account created successfully - now delete the OTP
      const otpKey = this.getOTPKey(dto.email, OTPPurpose.SIGNUP);
      await this.cacheManager.del(otpKey);

      // Send welcome email (don't await - fire and forget)
      this.emailService.sendWelcomeEmail({
        toEmail: user.email,
        userName: user.name,
      });

      // Generate tokens
      const tokens = await this.generateTokens(user.id, user.email, user.role);

      return {
        user: this.sanitizeUser(user),
        ...tokens,
      };
    } catch (error) {
      // If account creation fails, OTP remains in cache (user can retry)
      throw new BadRequestException('Failed to create account. Please try again.');
    }
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
    // Verify SSO token from platform
    const ssoResult = await this.supabaseService.verifySSOToken(dto.token);

    if (!ssoResult.valid) {
      throw new UnauthorizedException('Invalid SSO token');
    }

    // Find or create user
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          { ssoId: ssoResult.user?.id, ssoProvider: 'sso' },
        ],
      },
    });

    if (!user) {
      // Create new user from SSO
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name || dto.email.split('@')[0],
          ssoProvider: 'sso',
          ssoId: ssoResult.user?.id,
          userType: UserType.INTERNAL,
          plan: PlanType.PRO,
          unlimitedAccess: true,
        },
      });

      // Seed default categories for new user
      await this.seedDefaultCategories(user.id);

      // Seed default labels for new user
      await this.seedDefaultLabels(user.id);
    } else if (!user.ssoId) {
      // Link existing account to SSO
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ssoProvider: 'sso',
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
    await this.prisma.category.createMany({
      data: defaultCategories.map((cat) => ({
        ...cat,
        userId,
        isDefault: true,
      })),
    });
  }

  private async seedDefaultLabels(userId: string) {
    const currentYear = new Date().getFullYear();
    
    const defaultLabels = [
      { name: 'Q1', value: 'Q1', color: '#3B82F6', order: 1 },      // blue
      { name: 'Q2', value: 'Q2', color: '#22C55E', order: 2 },      // green
      { name: 'Q3', value: 'Q3', color: '#F97316', order: 3 },      // orange
      { name: 'Q4', value: 'Q4', color: '#EC4899', order: 4 },      // pink
      { name: `${currentYear}`, value: `${currentYear}`, color: '#8B5CF6', order: 5 }, // purple
      { name: 'High Priority', value: 'HIGH_PRIORITY', color: '#EF4444', order: 6 },  // red
      { name: 'Personal', value: 'PERSONAL', color: '#06B6D4', order: 7 },   // cyan
      { name: 'Professional', value: 'PROFESSIONAL', color: '#6366F1', order: 8 }, // indigo
    ];

    // Check if user already has labels
    const existingCount = await this.prisma.label.count({
      where: { userId },
    });

    if (existingCount > 0) {
      return; // Already seeded
    }

    // Create default labels
    await this.prisma.label.createMany({
      data: defaultLabels.map((label) => ({
        ...label,
        userId,
        isDefault: true,
      })),
    });
  }
}
