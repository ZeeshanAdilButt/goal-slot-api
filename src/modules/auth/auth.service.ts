import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Inject,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseService } from '../../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { EmailService } from '../email/email.service';
import { OtpAttemptTrackerService } from './otp-attempt-tracker.service';
import {
  RegisterDto,
  LoginDto,
  SSOLoginDto,
  SendOTPDto,
  VerifyOTPDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  OTPPurpose,
} from './dto/auth.dto';
import { User, UserRole, UserType, PlanType } from '@prisma/client';
import { resolvePlanLimits } from './plan-limits';
import { GoogleProfilePayload } from './strategies/google.strategy';

// OTP constants
const OTP_EXPIRY = 300; // 5 minutes in seconds
const OTP_RESEND_COOLDOWN = 60; // 60 seconds
const MAX_OTP_REQUESTS_PER_HOUR = 5;
const MAX_OTP_VERIFICATION_ATTEMPTS = 5; // Max failed attempts before lockout
const OTP_VERIFICATION_LOCKOUT_DURATION = 900000; // 15 minutes in milliseconds

// POST /auth/login had no brute-force protection at all: unlike OTP
// verification (locked out via OtpAttemptTrackerService above) or
// check-email (IP-throttled in AuthController), a wrong password could be
// retried without limit. bcrypt's cost factor slows a single guess but
// does not stop a scripted loop from trying thousands of passwords against
// one known email. Reuses OtpAttemptTrackerService (keyed by
// `${LOGIN_LOCKOUT_PURPOSE}:${email}`) rather than a new store, so the
// same atomic, unbounded, non-evicting semantics documented on that class
// apply here too.
const LOGIN_LOCKOUT_PURPOSE = 'login';
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_DURATION = 900000; // 15 minutes in milliseconds

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private supabaseService: SupabaseService,
    private usersService: UsersService,
    private emailService: EmailService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private otpAttemptTracker: OtpAttemptTrackerService,
  ) {}

  // OTP Helper Methods
  private generateOTP(): string {
    // crypto.randomInt is CSPRNG-backed, unlike Math.random() (CWE-338),
    // and rejection-samples internally so the output stays uniform over
    // [100000, 999999].
    return randomInt(100000, 1000000).toString();
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

  private async checkRateLimit(
    email: string,
    purpose: OTPPurpose,
  ): Promise<void> {
    const key = this.getRateLimitKey(email, purpose);
    const count = (await this.cacheManager.get<number>(key)) || 0;

    if (count >= MAX_OTP_REQUESTS_PER_HOUR) {
      throw new BadRequestException(
        'Too many OTP requests. Please wait before requesting another code.',
      );
    }

    // Increment counter with 1 hour TTL
    await this.cacheManager.set(key, count + 1, 3600000); // 3600000ms = 1 hour
  }

  private async checkResendCooldown(
    email: string,
    purpose: OTPPurpose,
  ): Promise<void> {
    const key = this.getResendCooldownKey(email, purpose);
    const cooldown = await this.cacheManager.get<boolean>(key);

    if (cooldown) {
      throw new BadRequestException(
        'Please wait 60 seconds before requesting a new code.',
      );
    }
  }

  // Verification attempt counting and lockout state live in
  // OtpAttemptTrackerService, a dedicated in-memory store, rather than the
  // shared cacheManager LRU used above for OTP codes/rate limits/cooldowns.
  // See that service for why: the shared cache is capped at 1000 entries
  // (eviction lets unrelated traffic wipe a victim's lockout) and its
  // get-then-set is not atomic (concurrent attempts could race past the cap).

  private checkVerificationLockout(email: string, purpose: OTPPurpose): void {
    if (this.otpAttemptTracker.isLockedOut(email, purpose)) {
      throw new BadRequestException(
        'Too many failed attempts. Your account is temporarily locked. Please try again in 15 minutes.',
      );
    }
  }

  private incrementVerificationAttempts(
    email: string,
    purpose: OTPPurpose,
  ): void {
    const { lockedOut } = this.otpAttemptTracker.recordFailedAttempt(
      email,
      purpose,
      MAX_OTP_VERIFICATION_ATTEMPTS,
      OTP_VERIFICATION_LOCKOUT_DURATION,
      OTP_VERIFICATION_LOCKOUT_DURATION,
    );

    if (lockedOut) {
      throw new BadRequestException(
        'Too many failed attempts. Your account is temporarily locked. Please try again in 15 minutes.',
      );
    }
  }

  private resetVerificationAttempts(email: string, purpose: OTPPurpose): void {
    this.otpAttemptTracker.reset(email, purpose);
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
        // Same generic response as the "OTP actually sent" path below, and
        // no OTP is generated or emailed. A distinct response here (the old
        // 409) let anyone enumerate registered emails by calling send-otp
        // directly; register() still independently rejects a duplicate
        // email as a final defense-in-depth.
        return {
          success: true,
          message: 'Verification code sent to your email.',
        };
      }
    }

    // For forgot password: validate user exists (silent fail for security)
    if (purpose === OTPPurpose.FORGOT_PASSWORD) {
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      // Silent fail - don't reveal if email exists or not
      if (!user) {
        return {
          success: true,
          message:
            'If this email is registered, you will receive a verification code.',
        };
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
      throw new BadRequestException(
        'OTP not found or expired. Please request a new code.',
      );
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

    // Verify the OTP before checking whether the account exists. Doing the
    // existence check first meant a wrong OTP against a nonexistent email
    // (401 "User not found") behaved differently from a wrong OTP against a
    // real one (401/400 from verifyOTP) -- an email-enumeration oracle.
    // sendForgotPasswordOTP never stores an OTP for an email with no
    // account, so verifyOTP already fails identically (no stored OTP) in
    // both cases.
    await this.verifyOTP({
      email,
      otp,
      purpose: OTPPurpose.FORGOT_PASSWORD,
    });

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Should not normally be reachable -- verifyOTP above would already
      // have thrown for an email with no account, since no OTP was ever
      // stored for it. Guarded anyway (e.g. account deleted mid-flow).
      throw new UnauthorizedException('User not found');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { id: user.id },
      // tokenVersion increments so any JWT issued before this reset --
      // including one an attacker obtained by compromising the account in
      // the first place -- fails JwtStrategy's version check on its very
      // next use, instead of staying valid for the rest of its natural
      // lifetime. Safe to do unconditionally here: resetPassword only ever
      // runs from the logged-out forgot-password flow, so there is no
      // "current session" of the caller's own to disrupt -- they get a
      // fresh token pair from the login they do right after this.
      data: { password: hashedPassword, tokenVersion: { increment: 1 } },
    });

    await this.revokeCliTokensForUser(user.id, 'PASSWORD_CHANGE');

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
      throw new BadRequestException(
        'Password change is not available for SSO users',
      );
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Send OTP
    await this.checkRateLimit(user.email, OTPPurpose.CHANGE_PASSWORD);
    await this.checkResendCooldown(user.email, OTPPurpose.CHANGE_PASSWORD);

    const otp = this.generateOTP();
    const otpKey = this.getOTPKey(user.email, OTPPurpose.CHANGE_PASSWORD);
    await this.cacheManager.set(otpKey, otp, OTP_EXPIRY * 1000);

    const cooldownKey = this.getResendCooldownKey(
      user.email,
      OTPPurpose.CHANGE_PASSWORD,
    );
    await this.cacheManager.set(cooldownKey, true, OTP_RESEND_COOLDOWN * 1000);

    // Send email
    await this.emailService.sendOTPEmail({
      toEmail: user.email,
      otp,
      purpose: 'forgot-password', // Reuse forgot-password template
    });

    return { success: true, message: 'Verification code sent to your email.' };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    otp: string,
    newPassword: string,
  ) {
    // Get user
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Check if user has a password (not SSO user)
    if (!user.password) {
      throw new BadRequestException(
        'Password change is not available for SSO users',
      );
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password,
    );
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
      // Update password. tokenVersion increments for the same reason as in
      // resetPassword above -- this revokes every outstanding JWT for the
      // account, including any the caller doesn't know about (a stolen
      // token being used elsewhere). Unlike resetPassword, this route runs
      // from an authenticated session, so the caller's own current token
      // is also revoked by this: their next request 401s, the web/mobile
      // clients' existing refresh-then-logout interceptor already handles
      // that gracefully, and they simply sign back in.
      await this.prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword, tokenVersion: { increment: 1 } },
      });

      await this.revokeCliTokensForUser(user.id, 'PASSWORD_CHANGE');

      // Delete OTP after successful password change
      const otpKey = this.getOTPKey(user.email, OTPPurpose.CHANGE_PASSWORD);
      await this.cacheManager.del(otpKey);

      return { success: true, message: 'Password changed successfully.' };
    } catch (error) {
      throw new BadRequestException(
        'Failed to change password. Please try again.',
      );
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
      // Calculate 60 days from now
      const sixtyDaysFromNow = new Date();
      sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);

      // Create user with default 60-day Basic trial
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          password: hashedPassword,
          name: dto.name,
          role: UserRole.USER,
          userType: UserType.EXTERNAL,
          plan: PlanType.BASIC,
          subscriptionStatus: 'active',
          subscriptionEndDate: sixtyDaysFromNow,
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
      const tokens = await this.generateTokens(
        user.id,
        user.email,
        user.role,
        user.tokenVersion,
      );

      return {
        user: this.sanitizeUser(user),
        ...tokens,
      };
    } catch (error) {
      // If account creation fails, OTP remains in cache (user can retry)
      throw new BadRequestException(
        'Failed to create account. Please try again.',
      );
    }
  }

  async login(dto: LoginDto) {
    const { email } = dto;

    // Checked before any DB/bcrypt work so a locked-out email fails the
    // same way whether or not the account exists -- no timing or response
    // difference for an attacker to enumerate accounts with.
    if (this.otpAttemptTracker.isLockedOut(email, LOGIN_LOCKOUT_PURPOSE)) {
      throw new UnauthorizedException(
        'Too many failed login attempts. Please try again in 15 minutes.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.password) {
      this.recordFailedLogin(email);
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      this.recordFailedLogin(email);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.isDisabled) {
      throw new UnauthorizedException('This account has been disabled');
    }

    // Successful login clears any prior failed-attempt count, same as OTP
    // verification does on success.
    this.otpAttemptTracker.reset(email, LOGIN_LOCKOUT_PURPOSE);

    const tokens = await this.generateTokens(
      user.id,
      user.email,
      user.role,
      user.tokenVersion,
    );

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  private recordFailedLogin(email: string): void {
    this.otpAttemptTracker.recordFailedAttempt(
      email,
      LOGIN_LOCKOUT_PURPOSE,
      MAX_LOGIN_ATTEMPTS,
      LOGIN_LOCKOUT_DURATION,
      LOGIN_LOCKOUT_DURATION,
    );
  }

  /**
   * Google sign-in. Deliberately NOT routed through ssoLogin: that path is the
   * internal DW Platform handoff and grants every account it touches
   * INTERNAL / PRO / unlimitedAccess. Google sign-in is public, so a Google
   * account is an ordinary EXTERNAL user on the FREE plan.
   */
  async handleGoogleLogin(profile: GoogleProfilePayload) {
    const { email, googleId } = profile;

    if (!email) {
      throw new UnauthorizedException(
        'Google account did not provide an email',
      );
    }

    // The account already linked to this Google identity is the only match
    // that needs no further proof: passport verified it against Google, and
    // the subject id is stable and unique per Google account.
    //
    // An email match is a separate, weaker case and is handled apart from it
    // on purpose. Folding both into one OR query -- which is what this did
    // first -- loses track of WHICH arm matched, so an account that already
    // carried some other federated identity sailed past the verification
    // guard below and got tokens issued off nothing but a matching address.
    let user = await this.prisma.user.findFirst({
      where: { ssoId: googleId, ssoProvider: 'google' },
    });

    if (!user) {
      const existingByEmail = await this.prisma.user.findFirst({
        where: { email },
      });

      if (existingByEmail) {
        // Reaching an existing account through an email match is only as
        // trustworthy as Google's assurance that this user owns the address.
        // Workspace and custom-domain accounts can carry an unverified email,
        // so without this check anyone able to create such an account on a
        // victim's address could sign straight into that victim's account.
        //
        // This guards every email match, not only unfederated ones: an
        // account already linked to DW Platform SSO is, if anything, the more
        // valuable one to steal.
        if (!profile.emailVerified) {
          throw new UnauthorizedException(
            'Your Google account email is not verified, so it cannot be used to sign in to an existing account.',
          );
        }

        user = existingByEmail.ssoId
          ? // Already federated to something else -- DW Platform SSO, or an
            // older Google subject on the same address. The verified email is
            // enough to let this person in, but overwriting ssoId/ssoProvider
            // would sever that other sign-in path, so the existing link stays.
            existingByEmail
          : await this.prisma.user.update({
              where: { id: existingByEmail.id },
              data: {
                ssoProvider: 'google',
                ssoId: googleId,
                avatar: existingByEmail.avatar ?? profile.avatar,
              },
            });
      }
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          name: profile.name || email.split('@')[0],
          avatar: profile.avatar,
          ssoProvider: 'google',
          ssoId: googleId,
          userType: UserType.EXTERNAL,
          role: UserRole.USER,
          plan: PlanType.FREE,
          // Google is the authority on this address, so there is nothing for
          // our own OTP flow to re-verify. Only set when Google says it is
          // verified -- see the linking guard above for why that matters.
          emailVerified: profile.emailVerified,
          emailVerifiedAt: profile.emailVerified ? new Date() : null,
        },
      });

      await this.seedDefaultCategories(user.id);
      await this.seedDefaultLabels(user.id);
    }

    // Same terminal check ssoLogin and login both make. Without it a disabled
    // account could still get a full token pair through this route.
    if (user.isDisabled) {
      throw new UnauthorizedException('This account has been disabled');
    }

    const tokens = await this.generateTokens(
      user.id,
      user.email,
      user.role,
      user.tokenVersion,
    );

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async ssoLogin(dto: SSOLoginDto) {
    // Verify SSO token from platform
    const ssoResult = await this.supabaseService.verifySSOToken(dto.token);

    if (!ssoResult.valid || !ssoResult.user?.email) {
      throw new UnauthorizedException('Invalid SSO token');
    }

    // The verified token is the only source of truth for identity. dto.email
    // is client-supplied and must never influence which account gets found,
    // created, or linked. Trusting it let anyone holding a valid Supabase
    // access token for this project log in as an arbitrary victim, silently
    // upgrade a victim's existing password account to INTERNAL/PRO by
    // linking it to their own SSO identity, or create a new elevated-access
    // account on a victim's email -- just by putting that email in the
    // request body.
    const verifiedEmail = ssoResult.user.email;
    const verifiedSsoId = ssoResult.user.id;

    // Find or create user, matched only on server-verified data.
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: verifiedEmail },
          { ssoId: verifiedSsoId, ssoProvider: 'sso' },
        ],
      },
    });

    if (!user) {
      // Create new user from SSO
      user = await this.prisma.user.create({
        data: {
          email: verifiedEmail,
          name: dto.name || ssoResult.user.name || verifiedEmail.split('@')[0],
          ssoProvider: 'sso',
          ssoId: verifiedSsoId,
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
      // Link existing account to SSO. Safe because `user` was matched above
      // on the verified email (or an already-linked verified ssoId), never
      // on the client-supplied dto.email.
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ssoProvider: 'sso',
          ssoId: verifiedSsoId,
          userType: UserType.INTERNAL,
          plan: PlanType.PRO,
          unlimitedAccess: true,
        },
      });
    }

    if (user.isDisabled) {
      throw new UnauthorizedException('This account has been disabled');
    }

    const tokens = await this.generateTokens(
      user.id,
      user.email,
      user.role,
      user.tokenVersion,
    );

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

    if (user.isDisabled) {
      throw new UnauthorizedException('This account has been disabled');
    }

    return this.generateTokens(
      user.id,
      user.email,
      user.role,
      user.tokenVersion,
    );
  }

  /**
   * Revokes every live CLI token on an account after a password change.
   *
   * tokenVersion alone does not cover these. It kills the CLI *access* token
   * (which carries the claim like any other), but the CLI refresh token is an
   * opaque DB row with no version on it, so without this the CLI would simply
   * mint itself a fresh access token minutes later and the password change
   * would not have revoked anything. Best effort: a failure here must not turn
   * a successful password change into an error the user reads as "it did not
   * work", when in fact the password is already changed.
   */
  private async revokeCliTokensForUser(
    userId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.cliToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    } catch (error) {
      this.logger.error(
        `Failed to revoke CLI tokens for user ${userId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async generateTokens(
    userId: string,
    email: string,
    role: UserRole,
    tokenVersion: number,
  ) {
    // tokenVersion travels in every minted token so JwtStrategy can compare
    // it against the User row on each request -- see the field's doc
    // comment in schema.prisma for why (this is what makes a password
    // change actually revoke outstanding sessions).
    const payload = { sub: userId, email, role, tokenVersion };

    // `typ` separates the two credentials. Before it existed both tokens
    // carried an identical payload signed with the same secret, so they
    // were fully interchangeable: a stolen refresh token was a 30-day
    // full-access API credential, and -- because POST /auth/refresh sat
    // behind the ordinary JwtAuthGuard -- either token could be laundered
    // into a fresh 30-day pair indefinitely. JwtStrategy now refuses a
    // 'refresh' token for API access and JwtRefreshStrategy refuses an
    // 'access' token at /auth/refresh, so the refresh token is only ever
    // good for exchanging itself.
    const accessToken = this.jwtService.sign({ ...payload, typ: 'access' });
    const refreshToken = this.jwtService.sign(
      { ...payload, typ: 'refresh' },
      { expiresIn: '30d' },
    );

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: User) {
    const { password, ...sanitized } = user;
    return {
      ...sanitized,
      limits: resolvePlanLimits(user),
    };
  }

  async checkPlanLimit(
    userId: string,
    limitType: 'goals' | 'schedules' | 'tasksPerDay' | 'activePractices',
    currentCount: number,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ForbiddenException('User not found');

    return this.checkPlanLimitForUser(user, limitType, currentCount);
  }

  // Same check as checkPlanLimit, but for callers that already have the User
  // row in hand (typically because they fetched it themselves to run
  // concurrently with other independent queries). Lets them avoid a second
  // `user.findUnique` round-trip just to re-derive plan limits.
  checkPlanLimitForUser(
    user: User,
    limitType: 'goals' | 'schedules' | 'tasksPerDay' | 'activePractices',
    currentCount: number,
  ) {
    const limits = resolvePlanLimits(user);

    const limitMap = {
      goals: limits.maxGoals,
      schedules: limits.maxSchedules,
      tasksPerDay: limits.maxTasksPerDay,
      activePractices: limits.maxActivePractices,
    } as const;

    if (currentCount >= limitMap[limitType]) {
      throw new ForbiddenException(
        `You've reached your ${user.plan} plan limit for ${limitType}. Upgrade to Max for unlimited access.`,
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
      {
        name: 'Side Project',
        value: 'SIDE_PROJECT',
        color: '#EC4899',
        order: 7,
      }, // pink-500
      { name: 'DSA', value: 'DSA', color: '#FFD700', order: 8 }, // yellow/gold
      { name: 'Meeting', value: 'MEETING', color: '#8B5CF6', order: 9 }, // purple-500
      { name: 'Admin', value: 'ADMIN', color: '#9CA3AF', order: 10 }, // gray-400
      { name: 'Break', value: 'BREAK', color: '#D1D5DB', order: 11 }, // gray-300
      { name: 'Spiritual', value: 'SPIRITUAL', color: '#10B981', order: 12 }, // emerald-500
      { name: 'Community', value: 'COMMUNITY', color: '#A855F7', order: 13 }, // purple-500
      { name: 'Other', value: 'OTHER', color: '#9CA3AF', order: 14 }, // gray-400
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
      { name: 'Q1', value: 'Q1', color: '#3B82F6', order: 1 }, // blue
      { name: 'Q2', value: 'Q2', color: '#22C55E', order: 2 }, // green
      { name: 'Q3', value: 'Q3', color: '#F97316', order: 3 }, // orange
      { name: 'Q4', value: 'Q4', color: '#EC4899', order: 4 }, // pink
      {
        name: `${currentYear}`,
        value: `${currentYear}`,
        color: '#8B5CF6',
        order: 5,
      }, // purple
      {
        name: 'High Priority',
        value: 'HIGH_PRIORITY',
        color: '#EF4444',
        order: 6,
      }, // red
      { name: 'Personal', value: 'PERSONAL', color: '#06B6D4', order: 7 }, // cyan
      {
        name: 'Professional',
        value: 'PROFESSIONAL',
        color: '#6366F1',
        order: 8,
      }, // indigo
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
