import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

interface FakeUserRecord {
  id: string;
  email: string;
  role: string;
  isDisabled: boolean;
}

function buildStrategy(users: FakeUserRecord[]) {
  const findUnique = jest.fn(async (args: { where: { id: string }; select?: any }) => {
    const user = users.find((u) => u.id === args.where.id);
    return user ?? null;
  });
  const prisma = { user: { findUnique } };
  const configService = { get: () => 'test-jwt-secret' } as any;

  const strategy = new JwtStrategy(configService, prisma as any);
  return { strategy, prisma, findUnique };
}

describe('JwtStrategy.validate', () => {
  it('rejects a token belonging to a user who has since been disabled', async () => {
    // This is the whole point of the fix: admin disables the account via
    // POST /users/admin/toggle-status/:userId, and any request made with a
    // token issued before that must now be rejected on the very next call,
    // even though the token itself is still cryptographically valid and
    // unexpired.
    const { strategy } = buildStrategy([
      { id: 'user_1', email: 'disabled@example.com', role: 'USER', isDisabled: true },
    ]);

    await expect(
      strategy.validate({ sub: 'user_1', email: 'disabled@example.com', role: 'USER' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token for a user id that no longer exists', async () => {
    const { strategy } = buildStrategy([]);

    await expect(
      strategy.validate({ sub: 'deleted-user', email: 'ghost@example.com', role: 'USER' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('looks the user up by payload.sub instead of trusting the payload directly', async () => {
    const { strategy, findUnique } = buildStrategy([
      { id: 'user_1', email: 'real@example.com', role: 'USER', isDisabled: false },
    ]);

    await strategy.validate({ sub: 'user_1', email: 'real@example.com', role: 'USER' });

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_1' } }),
    );
  });

  it('returns the fresh DB role/email for an active user, ignoring a stale/forged payload role', async () => {
    const { strategy } = buildStrategy([
      { id: 'user_1', email: 'real@example.com', role: 'USER', isDisabled: false },
    ]);

    // A payload claiming ADMIN must not be echoed back verbatim -- the DB
    // record is the source of truth.
    const result = await strategy.validate({ sub: 'user_1', email: 'real@example.com', role: 'ADMIN' });

    expect(result).toEqual({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'USER',
      isDisabled: false,
    });
  });
});
