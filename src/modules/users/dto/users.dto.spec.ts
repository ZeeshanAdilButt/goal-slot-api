import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRole } from '@prisma/client';
import { CreateInternalUserDto } from './users.dto';
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
