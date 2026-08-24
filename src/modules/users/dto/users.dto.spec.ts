import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRole } from '@prisma/client';
import {
  CreateInternalUserDto,
  UpdateUserDto,
  DAILY_FOCUS_GOAL_MIN_MINUTES,
  DAILY_FOCUS_GOAL_MAX_MINUTES,
} from './users.dto';
import { BulkInviteDto } from './bulk-invite.dto';

// Regression cover for admin self-promotion.
//
// Both DTOs validated `role` with @IsEnum(UserRole), which accepts
// SUPER_ADMIN. POST /api/users/admin/internal and /api/users/admin/bulk-invite
// are open to ADMIN, so any admin could mint a SUPER_ADMIN account and log
// into it. SUPER_ADMIN is only supposed to be reachable through
// /admin/promote/:userId, which is itself SUPER_ADMIN-only.

async function errorsFor(cls: any, payload: Record<string, any>) {
  return validate(plainToInstance(cls, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

const internalUserBase = {
  email: 'mentor@example.com',
  password: 'SecurePassword123!',
  name: 'Jane Mentor',
};

describe('CreateInternalUserDto role', () => {
  it('rejects SUPER_ADMIN', async () => {
    const errors = await errorsFor(CreateInternalUserDto, {
      ...internalUserBase,
      role: UserRole.SUPER_ADMIN,
    });

    expect(errors.map((e) => e.property)).toContain('role');
  });

  it.each([UserRole.USER, UserRole.ADMIN])('accepts %s', async (role) => {
    const errors = await errorsFor(CreateInternalUserDto, {
      ...internalUserBase,
      role,
    });

    expect(errors).toHaveLength(0);
  });

  it('still allows role to be omitted', async () => {
    const errors = await errorsFor(CreateInternalUserDto, internalUserBase);

    expect(errors).toHaveLength(0);
  });

  it('rejects an arbitrary string', async () => {
    const errors = await errorsFor(CreateInternalUserDto, {
      ...internalUserBase,
      role: 'ROOT',
    });

    expect(errors.map((e) => e.property)).toContain('role');
  });
});

describe('BulkInviteDto role', () => {
  it('rejects SUPER_ADMIN', async () => {
    const errors = await errorsFor(BulkInviteDto, {
      text: 'alice@example.com',
      role: UserRole.SUPER_ADMIN,
    });

    expect(errors.map((e) => e.property)).toContain('role');
  });

  it.each([UserRole.USER, UserRole.ADMIN])('accepts %s', async (role) => {
    const errors = await errorsFor(BulkInviteDto, {
      text: 'alice@example.com',
      role,
    });

    expect(errors).toHaveLength(0);
  });

  it('still allows role to be omitted', async () => {
    const errors = await errorsFor(BulkInviteDto, {
      text: 'alice@example.com',
    });

    expect(errors).toHaveLength(0);
  });
});

// Bounds cover for the per-user daily focus goal.
//
// The Focus Streak card used to compare against a hardcoded 30-minute
// constant, which the goal owner cleared before breakfast. The goal is now
// per-user with a 240-minute (4h) default -- but 240 is a default, NOT a
// floor, so the DTO has to keep accepting values below it while still
// rejecting nonsense (0, negatives, fractions, more than a day).

describe('UpdateUserDto dailyFocusGoalMinutes', () => {
  it('accepts the 240-minute default', async () => {
    const errors = await errorsFor(UpdateUserDto, {
      dailyFocusGoalMinutes: 240,
    });

    expect(errors).toHaveLength(0);
  });

  it('is optional -- an avatar/name-only update still validates', async () => {
    const errors = await errorsFor(UpdateUserDto, { name: 'Jane' });

    expect(errors).toHaveLength(0);
  });

  it.each([
    DAILY_FOCUS_GOAL_MIN_MINUTES,
    30,
    120,
    DAILY_FOCUS_GOAL_MAX_MINUTES,
  ])('accepts %i minutes', async (dailyFocusGoalMinutes) => {
    const errors = await errorsFor(UpdateUserDto, { dailyFocusGoalMinutes });

    expect(errors).toHaveLength(0);
  });

  it.each([
    DAILY_FOCUS_GOAL_MIN_MINUTES - 1,
    0,
    -60,
    DAILY_FOCUS_GOAL_MAX_MINUTES + 1,
    5000,
  ])('rejects %i minutes as out of range', async (dailyFocusGoalMinutes) => {
    const errors = await errorsFor(UpdateUserDto, { dailyFocusGoalMinutes });

    expect(errors.map((e) => e.property)).toContain('dailyFocusGoalMinutes');
  });

  it.each([90.5, '90', null, true])(
    'rejects %p as not a whole number of minutes',
    async (dailyFocusGoalMinutes) => {
      const errors = await errorsFor(UpdateUserDto, { dailyFocusGoalMinutes });

      expect(errors.map((e) => e.property)).toContain('dailyFocusGoalMinutes');
    },
  );

  it('explains the range in the rejection message', async () => {
    const [error] = await errorsFor(UpdateUserDto, {
      dailyFocusGoalMinutes: 5,
    });

    expect(Object.values(error.constraints ?? {}).join(' ')).toContain(
      String(DAILY_FOCUS_GOAL_MIN_MINUTES),
    );
  });
});
