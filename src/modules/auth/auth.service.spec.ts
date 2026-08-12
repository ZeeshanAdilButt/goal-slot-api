import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpAttemptTrackerService } from './otp-attempt-tracker.service';
import { OTPPurpose } from './dto/auth.dto';

// ---------- Fakes ----------

class FakeUserStore {
  users: any[] = [];
  private nextId = 1;

  private matches(user: any, cond: Record<string, any>): boolean {
    return Object.entries(cond).every(([key, value]) => user[key] === value);
  }

  findUnique = async (args: any) => {
    const where = args.where;
    if (where.id !== undefined) return this.users.find((u) => u.id === where.id) ?? null;
    if (where.email !== undefined) return this.users.find((u) => u.email === where.email) ?? null;
    return null;
  };

  findFirst = async (args: any) => {
    const orConditions: any[] = args.where?.OR ?? [args.where];
    return this.users.find((u) => orConditions.some((cond) => this.matches(u, cond))) ?? null;
  };

  create = async (args: any) => {
    const user = {
      id: `user_${this.nextId++}`,
      role: 'USER',
      isDisabled: false,
      userType: 'EXTERNAL',
      plan: 'FREE',
      ssoId: null,
      ssoProvider: null,
      ...args.data,
    };
    this.users.push(user);
    return user;
  };

  update = async (args: any) => {
    const user = this.users.find((u) => u.id === args.where.id);
    if (!user) throw new Error('user not found in fake store');
    Object.assign(user, args.data);
    return user;
  };
}

class FakePrisma {
  private store = new FakeUserStore();
  user = this.store;
  category = {
    count: async () => 0,
    createMany: async () => ({ count: 0 }),
  };
  label = {
    count: async () => 0,
    createMany: async () => ({ count: 0 }),
  };

  get users() {
    return this.store.users;
  }
}

class FakeCacheManager {
  private store = new Map<string, any>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: any, _ttl?: number): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class FakeJwtService {
  sign(payload: any) {
    return `fake-token:${JSON.stringify(payload)}`;
  }
}

class FakeSupabaseService {
  result: { valid: boolean; user?: { id: string; email?: string; name?: string } } = { valid: false };

  async verifySSOToken(_token: string) {
    return this.result;
  }
}

class FakeEmailService {
  sendOTPEmail = jest.fn(async () => undefined);
  sendWelcomeEmail = jest.fn(async () => undefined);
}

function buildAuthService() {
  const prisma = new FakePrisma();
  const cacheManager = new FakeCacheManager();
  const jwtService = new FakeJwtService();
  const supabaseService = new FakeSupabaseService();
  const emailService = new FakeEmailService();
  const otpAttemptTracker = new OtpAttemptTrackerService();
  const configService = { get: () => undefined } as any;
  const usersService = {} as any;

  const authService = new AuthService(
    prisma as any,
    jwtService as any,
    configService,
    supabaseService as any,
    usersService,
    emailService as any,
    cacheManager as any,
    otpAttemptTracker,
  );

  return { authService, prisma, cacheManager, jwtService, supabaseService, emailService, otpAttemptTracker };
}

// ---------- SSO login trusts only the verified token email ----------

describe('AuthService.ssoLogin', () => {
  it('creates the account under the verified token email, not the client-supplied dto.email', async () => {
    const { authService, supabaseService, prisma } = buildAuthService();
    supabaseService.result = {
      valid: true,
      user: { id: 'supabase-id-1', email: 'victim@company.com', name: 'Victim' },
    };

    const result = await authService.ssoLogin({
      token: 'valid-token',
      email: 'attacker@evil.com', // attacker-controlled, must be ignored
      name: 'Attacker Name',
    } as any);

    expect(result.user.email).toBe('victim@company.com');
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0].email).toBe('victim@company.com');
    expect(prisma.users[0].ssoId).toBe('supabase-id-1');
  });

  it('does not find, log in as, or modify an existing account under the attacker-supplied dto.email', async () => {
    const { authService, supabaseService, prisma } = buildAuthService();
    // A real victim account already exists, matched to a *different*
    // Supabase identity than the one presenting the token.
    prisma.users.push({
      id: 'victim-user',
      email: 'victim@company.com',
      password: 'hashed-password',
      role: 'USER',
      isDisabled: false,
      userType: 'EXTERNAL',
      plan: 'BASIC',
      ssoId: null,
      ssoProvider: null,
    });

    // Attacker's own valid Supabase token, but they claim the victim's email
    // in the request body hoping the server trusts it.
    supabaseService.result = {
      valid: true,
      user: { id: 'attacker-supabase-id', email: 'attacker@evil.com', name: 'Attacker' },
    };

    const result = await authService.ssoLogin({
      token: 'attackers-own-valid-token',
      email: 'victim@company.com',
      name: 'Attacker',
    } as any);

    // A brand new account was created for the attacker's own verified
    // identity; the victim's account must be untouched.
    expect(result.user.email).toBe('attacker@evil.com');
    const victim = prisma.users.find((u: any) => u.id === 'victim-user');
    expect(victim.ssoId).toBeNull();
    expect(victim.userType).toBe('EXTERNAL');
    expect(victim.plan).toBe('BASIC');
  });

  it('links an existing password account to SSO only when the verified email actually matches', async () => {
    const { authService, supabaseService, prisma } = buildAuthService();
    prisma.users.push({
      id: 'existing-user',
      email: 'real@example.com',
      password: 'hashed-password',
      role: 'USER',
      isDisabled: false,
      userType: 'EXTERNAL',
      plan: 'FREE',
      ssoId: null,
      ssoProvider: null,
    });

    supabaseService.result = {
      valid: true,
      user: { id: 'sso-id-real', email: 'real@example.com', name: 'Real Person' },
    };

    const result = await authService.ssoLogin({
      token: 'valid-token',
      email: 'real@example.com',
      name: 'Real Person',
    } as any);

    expect(result.user.id).toBe('existing-user');
    expect(prisma.users).toHaveLength(1);
    const linked = prisma.users[0];
    expect(linked.ssoId).toBe('sso-id-real');
    expect(linked.userType).toBe('INTERNAL');
  });

  it('rejects when the SSO token is invalid', async () => {
    const { authService, supabaseService } = buildAuthService();
    supabaseService.result = { valid: false };

    await expect(
      authService.ssoLogin({ token: 'bad-token', email: 'x@example.com' } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a disabled account trying to obtain a fresh token via SSO', async () => {
    const { authService, supabaseService, prisma } = buildAuthService();
    prisma.users.push({
      id: 'disabled-user',
      email: 'disabled@example.com',
      role: 'USER',
      isDisabled: true,
      userType: 'INTERNAL',
      plan: 'PRO',
      ssoId: 'sso-id-disabled',
      ssoProvider: 'sso',
    });
    supabaseService.result = {
      valid: true,
      user: { id: 'sso-id-disabled', email: 'disabled@example.com' },
    };

    await expect(
      authService.ssoLogin({ token: 'valid-token', email: 'disabled@example.com' } as any),
    ).rejects.toThrow('This account has been disabled');
  });
});

// ---------- OTP generation is cryptographically secure ----------

describe('AuthService OTP generation', () => {
  it('uses crypto.randomInt (not Math.random) to generate the 6-digit code', () => {
    const { authService } = buildAuthService();
    const randomIntSpy = jest.spyOn(crypto, 'randomInt');
    const mathRandomSpy = jest.spyOn(Math, 'random');

    const otp = (authService as any).generateOTP();

    expect(randomIntSpy).toHaveBeenCalledWith(100000, 1000000);
    expect(mathRandomSpy).not.toHaveBeenCalled();
    expect(otp).toMatch(/^\d{6}$/);

    randomIntSpy.mockRestore();
    mathRandomSpy.mockRestore();
  });
});

// ---------- OTP verification lockout is atomic under concurrency ----------

describe('AuthService.verifyOTP concurrency', () => {
  it('trips the lockout under a burst of concurrent brute-force attempts', async () => {
    const { authService, cacheManager } = buildAuthService();
    const email = 'victim@example.com';
    const purpose = OTPPurpose.FORGOT_PASSWORD;
    await cacheManager.set(`otp:${email}:${purpose}`, '111111');

    const totalAttempts = 10; // comfortably above MAX_OTP_VERIFICATION_ATTEMPTS (5)
    const outcomes = await Promise.allSettled(
      Array.from({ length: totalAttempts }, () =>
        authService.verifyOTP({ email, otp: '000000', purpose }),
      ),
    );

    const invalidOtpRejections = outcomes.filter(
      (o) => o.status === 'rejected' && String((o as any).reason?.message).includes('Invalid OTP'),
    );
    const lockedOutRejections = outcomes.filter(
      (o) => o.status === 'rejected' && String((o as any).reason?.message).includes('temporarily locked'),
    );

    // With a properly atomic counter, 10 concurrent wrong guesses cannot
    // all come back as plain "Invalid OTP" -- the non-atomic get-then-set
    // implementation being replaced here allowed exactly that, because
    // concurrent requests read the same starting count before writing back.
    expect(invalidOtpRejections.length).toBeLessThan(totalAttempts);
    expect(lockedOutRejections.length).toBeGreaterThan(0);

    // The lockout must be durable: a follow-up call after the burst is
    // rejected even with the *correct* OTP, proving the lock isn't just a
    // per-request fluke.
    await expect(authService.verifyOTP({ email, otp: '111111', purpose })).rejects.toThrow(
      'temporarily locked',
    );
  });

  it('does not lock out on a single wrong attempt and clears the counter on success', async () => {
    const { authService, cacheManager } = buildAuthService();
    const email = 'legit@example.com';
    const purpose = OTPPurpose.SIGNUP;
    await cacheManager.set(`otp:${email}:${purpose}`, '654321');

    await expect(authService.verifyOTP({ email, otp: '000000', purpose })).rejects.toThrow(
      'Invalid OTP code',
    );

    await expect(authService.verifyOTP({ email, otp: '654321', purpose })).resolves.toBe(true);
  });
});

// ---------- Disabled accounts cannot obtain new tokens ----------

describe('AuthService.login / refreshToken with a disabled account', () => {
  it('login rejects a disabled user even with the correct password', async () => {
    const { authService, prisma } = buildAuthService();
    const hashed = await bcrypt.hash('correct-password', 10);
    prisma.users.push({
      id: 'user_1',
      email: 'disabled@example.com',
      password: hashed,
      role: 'USER',
      isDisabled: true,
      userType: 'EXTERNAL',
      plan: 'FREE',
    });

    await expect(
      authService.login({ email: 'disabled@example.com', password: 'correct-password' }),
    ).rejects.toThrow('This account has been disabled');
  });

  it('login still rejects wrong credentials before ever revealing disabled status', async () => {
    const { authService, prisma } = buildAuthService();
    const hashed = await bcrypt.hash('correct-password', 10);
    prisma.users.push({
      id: 'user_1',
      email: 'disabled@example.com',
      password: hashed,
      role: 'USER',
      isDisabled: true,
      userType: 'EXTERNAL',
      plan: 'FREE',
    });

    await expect(
      authService.login({ email: 'disabled@example.com', password: 'wrong-password' }),
    ).rejects.toThrow('Invalid credentials');
  });

  it('login succeeds for an active user with correct credentials', async () => {
    const { authService, prisma } = buildAuthService();
    const hashed = await bcrypt.hash('correct-password', 10);
    prisma.users.push({
      id: 'user_1',
      email: 'active@example.com',
      password: hashed,
      role: 'USER',
      isDisabled: false,
      userType: 'EXTERNAL',
      plan: 'FREE',
    });

    const result = await authService.login({ email: 'active@example.com', password: 'correct-password' });
    expect(result.user.email).toBe('active@example.com');
    expect(result.accessToken).toBeDefined();
  });

  it('refreshToken rejects a disabled user', async () => {
    const { authService, prisma } = buildAuthService();
    prisma.users.push({
      id: 'user_1',
      email: 'disabled@example.com',
      role: 'USER',
      isDisabled: true,
      userType: 'EXTERNAL',
      plan: 'FREE',
    });

    await expect(authService.refreshToken('user_1')).rejects.toThrow('This account has been disabled');
  });

  it('refreshToken succeeds for an active user', async () => {
    const { authService, prisma } = buildAuthService();
    prisma.users.push({
      id: 'user_1',
      email: 'active@example.com',
      role: 'USER',
      isDisabled: false,
      userType: 'EXTERNAL',
      plan: 'FREE',
    });

    const tokens = await authService.refreshToken('user_1');
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
  });
});

// ---------- Email enumeration fixes ----------

describe('AuthService email enumeration fixes', () => {
  it('sendOTP for SIGNUP returns the same generic response for an already-registered email', async () => {
    const { authService, prisma, emailService } = buildAuthService();
    prisma.users.push({
      id: 'user_1',
      email: 'taken@example.com',
      role: 'USER',
      isDisabled: false,
      userType: 'EXTERNAL',
      plan: 'FREE',
    });

    const result = await authService.sendOTP({ email: 'taken@example.com', purpose: OTPPurpose.SIGNUP });

    expect(result).toEqual({ success: true, message: 'Verification code sent to your email.' });
    expect(emailService.sendOTPEmail).not.toHaveBeenCalled();
  });

  it('sendOTP for SIGNUP sends a real code and the same-shaped response for a new email', async () => {
    const { authService, emailService } = buildAuthService();

    const result = await authService.sendOTP({ email: 'new@example.com', purpose: OTPPurpose.SIGNUP });

    expect(result).toEqual({ success: true, message: 'Verification code sent to your email.' });
    expect(emailService.sendOTPEmail).toHaveBeenCalledTimes(1);
  });

  it('resetPassword fails identically for a wrong OTP whether or not the email is registered', async () => {
    const { authService, prisma } = buildAuthService();
    prisma.users.push({
      id: 'user_1',
      email: 'real@example.com',
      password: 'hashed',
      role: 'USER',
      isDisabled: false,
      userType: 'EXTERNAL',
      plan: 'FREE',
    });

    const realEmailAttempt = authService.resetPassword({
      email: 'real@example.com',
      otp: '000000',
      newPassword: 'NewPassword123!',
    });
    const fakeEmailAttempt = authService.resetPassword({
      email: 'nonexistent@example.com',
      otp: '000000',
      newPassword: 'NewPassword123!',
    });

    const [realResult, fakeResult] = await Promise.allSettled([realEmailAttempt, fakeEmailAttempt]);

    expect(realResult.status).toBe('rejected');
    expect(fakeResult.status).toBe('rejected');
    expect((realResult as PromiseRejectedResult).reason.message).toBe(
      (fakeResult as PromiseRejectedResult).reason.message,
    );
    expect((realResult as PromiseRejectedResult).reason.status).toBe(
      (fakeResult as PromiseRejectedResult).reason.status,
    );
  });
});
