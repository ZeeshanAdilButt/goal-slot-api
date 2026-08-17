import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

interface FakeUserRecord {
  id: string;
  email: string;
  role: string;
  isDisabled: boolean;
  tokenVersion?: number;
}

function buildStrategy(users: FakeUserRecord[]) {
  const findUnique = jest.fn(
    async (args: { where: { id: string }; select?: any }) => {
      const user = users.find((u) => u.id === args.where.id);
      // Real Prisma always returns the column; default it here so tests
      // written before tokenVersion existed don't all need updating just
      // to opt into the default value new rows get.
      return user ? { tokenVersion: 0, ...user } : null;
    },
  );
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
      {
        id: 'user_1',
        email: 'disabled@example.com',
        role: 'USER',
        isDisabled: true,
      },
    ]);

    await expect(
      strategy.validate({
        sub: 'user_1',
        email: 'disabled@example.com',
        role: 'USER',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token for a user id that no longer exists', async () => {
    const { strategy } = buildStrategy([]);

    await expect(
      strategy.validate({
        sub: 'deleted-user',
        email: 'ghost@example.com',
        role: 'USER',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('looks the user up by payload.sub instead of trusting the payload directly', async () => {
    const { strategy, findUnique } = buildStrategy([
      {
        id: 'user_1',
        email: 'real@example.com',
        role: 'USER',
        isDisabled: false,
      },
    ]);

    await strategy.validate({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'USER',
    });

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_1' } }),
    );
  });

  it('returns the fresh DB role/email for an active user, ignoring a stale/forged payload role', async () => {
    const { strategy } = buildStrategy([
      {
        id: 'user_1',
        email: 'real@example.com',
        role: 'USER',
        isDisabled: false,
      },
    ]);

    // A payload claiming ADMIN must not be echoed back verbatim -- the DB
    // record is the source of truth.
    const result = await strategy.validate({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'ADMIN',
    });

    expect(result).toEqual({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'USER',
      isDisabled: false,
    });
  });

  it('rejects a token whose tokenVersion is behind the user\'s current one (revoked by a password change)', async () => {
    const { strategy } = buildStrategy([
      {
        id: 'user_1',
        email: 'real@example.com',
        role: 'USER',
        isDisabled: false,
        tokenVersion: 2,
      },
    ]);

    // Token was minted back when the column was at version 1; the user has
    // since changed their password once (bumping it to 2), so this token
    // -- despite being cryptographically valid and unexpired -- must be
    // rejected.
    await expect(
      strategy.validate({
        sub: 'user_1',
        email: 'real@example.com',
        role: 'USER',
        tokenVersion: 1,
      }),
    ).rejects.toThrow('Session has been invalidated by a password change');
  });

  it('accepts a token with no tokenVersion claim when the user is still at the column default of 0', async () => {
    // Tokens minted before this field existed carry no tokenVersion claim
    // at all. A user who has never changed their password since is still
    // at the default (0), so payload.tokenVersion ?? 0 must match without
    // forcing every pre-existing session to log out on deploy.
    const { strategy } = buildStrategy([
      {
        id: 'user_1',
        email: 'real@example.com',
        role: 'USER',
        isDisabled: false,
        tokenVersion: 0,
      },
    ]);

    await expect(
      strategy.validate({
        sub: 'user_1',
        email: 'real@example.com',
        role: 'USER',
      }),
    ).resolves.toEqual({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'USER',
      isDisabled: false,
    });
  });

  it('rejects a claim-less token once the user has changed their password at least once', async () => {
    const { strategy } = buildStrategy([
      {
        id: 'user_1',
        email: 'real@example.com',
        role: 'USER',
        isDisabled: false,
        tokenVersion: 1,
      },
    ]);

    await expect(
      strategy.validate({
        sub: 'user_1',
        email: 'real@example.com',
        role: 'USER',
      }),
    ).rejects.toThrow('Session has been invalidated by a password change');
  });
});
