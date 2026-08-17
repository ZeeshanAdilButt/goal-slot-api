import { UnauthorizedException } from '@nestjs/common';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';

interface FakeUserRecord {
  id: string;
  email: string;
  role: string;
  isDisabled: boolean;
  tokenVersion?: number;
}

function buildStrategy(users: FakeUserRecord[]) {
  const findUnique = jest.fn(async (args: { where: { id: string } }) => {
    const user = users.find((u) => u.id === args.where.id);
    return user ? { tokenVersion: 0, ...user } : null;
  });
  const prisma = { user: { findUnique } };
  const configService = { get: () => 'test-jwt-secret' } as any;

  const strategy = new JwtRefreshStrategy(configService, prisma as any);
  return { strategy, prisma, findUnique };
}

const activeUser: FakeUserRecord = {
  id: 'user_1',
  email: 'real@example.com',
  role: 'USER',
  isDisabled: false,
  tokenVersion: 0,
};

describe('JwtRefreshStrategy.validate', () => {
  it('rejects an access token, so it cannot be laundered into a fresh 30-day pair', async () => {
    // POST /auth/refresh mints a brand-new access + 30-day refresh pair.
    // While it sat behind the ordinary JwtAuthGuard, an attacker holding
    // only a stolen 7-day access token could call it every few days and
    // keep the account indefinitely -- the token never aged out.
    const { strategy } = buildStrategy([activeUser]);

    await expect(
      strategy.validate({ sub: 'user_1', tokenVersion: 0, typ: 'access' }),
    ).rejects.toThrow('A refresh token is required for this endpoint');
  });

  it('accepts a refresh-typed token', async () => {
    const { strategy } = buildStrategy([activeUser]);

    await expect(
      strategy.validate({ sub: 'user_1', tokenVersion: 0, typ: 'refresh' }),
    ).resolves.toEqual({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'USER',
      isDisabled: false,
    });
  });

  it('accepts an untyped legacy refresh token during the transition window', async () => {
    // Refresh tokens minted before the `typ` claim existed carry none.
    // Rejecting them would force-log-out every live web and mobile session
    // as soon as its access token expired and the client interceptor fired
    // its first refresh. See the dated comment in jwt-refresh.strategy.ts.
    const { strategy } = buildStrategy([activeUser]);

    await expect(
      strategy.validate({ sub: 'user_1', tokenVersion: 0 }),
    ).resolves.toEqual({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'USER',
      isDisabled: false,
    });
  });

  it('rejects a token for a user who has since been disabled', async () => {
    const { strategy } = buildStrategy([{ ...activeUser, isDisabled: true }]);

    await expect(
      strategy.validate({ sub: 'user_1', tokenVersion: 0, typ: 'refresh' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token for a user id that no longer exists', async () => {
    const { strategy } = buildStrategy([]);

    await expect(
      strategy.validate({ sub: 'deleted-user', typ: 'refresh' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a refresh token revoked by a password change', async () => {
    // Without this the revocation would be trivially undone: the stale
    // refresh token would mint a fresh access token carrying the *new*
    // tokenVersion read from the DB.
    const { strategy } = buildStrategy([{ ...activeUser, tokenVersion: 2 }]);

    await expect(
      strategy.validate({ sub: 'user_1', tokenVersion: 1, typ: 'refresh' }),
    ).rejects.toThrow('Session has been invalidated by a password change');
  });

  it('returns the fresh DB role, ignoring a forged payload role', async () => {
    const { strategy } = buildStrategy([activeUser]);

    const result = await strategy.validate({
      sub: 'user_1',
      email: 'attacker@example.com',
      role: 'ADMIN',
      tokenVersion: 0,
      typ: 'refresh',
    });

    expect(result).toEqual({
      sub: 'user_1',
      email: 'real@example.com',
      role: 'USER',
      isDisabled: false,
    });
  });
});
