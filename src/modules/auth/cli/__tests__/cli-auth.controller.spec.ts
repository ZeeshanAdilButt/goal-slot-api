import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  CanActivate,
  ForbiddenException,
  GoneException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CliAuthController } from '../cli-auth.controller';
import { CliAuthService } from '../cli-auth.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';

/**
 * HTTP-level tests for POST /auth/cli/token.
 *
 * These boot a real Nest app and make real requests rather than calling the
 * handler directly, because the thing being asserted is the status code, and
 * the status code is decided by Nest's response pipeline (which @HttpCode,
 * @Res and a thrown HttpException all pull on in different directions). A
 * handler-level test would happily "pass" while the wire carried 200 for a
 * pending poll, and the CLI would spin forever on a session that was never
 * approved.
 */
describe('CliAuthController POST /auth/cli/token', () => {
  let app: INestApplication;
  let baseUrl: string;
  const exchangeToken = jest.fn();

  const allowAll: CanActivate = { canActivate: () => true };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CliAuthController],
      providers: [{ provide: CliAuthService, useValue: { exchangeToken } }],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue(allowAll)
      .overrideGuard(JwtAuthGuard)
      .useValue(allowAll)
      .compile();

    app = moduleRef.createNestApplication();
    // Same pipe main.ts installs, so DTO validation behaves as it does live.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');

    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/auth/cli`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => exchangeToken.mockReset());

  const body = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    sessionSecret: 'gsl_ss_0123456789abcdefghijklmnopqrstuvwxyz',
    codeVerifier: 'a'.repeat(43),
    authorizationCode: 'gsl_ac_0123456789abcdefghijklmnopqrstuvwxyz',
  };

  const post = (payload: unknown = body) =>
    fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('returns 200 with the token payload once the session is approved', async () => {
    exchangeToken.mockResolvedValue({
      tokenType: 'Bearer',
      accessToken: 'jwt',
      refreshToken: 'gsl_rt_x',
      tokenId: 'token_1',
    });

    const res = await post();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('returns 202 while the session is still pending', async () => {
    exchangeToken.mockResolvedValue({
      status: 'PENDING',
      interval: 5,
      pending: true,
    });

    const res = await post();

    expect(res.status).toBe(202);
    // The `pending` discriminator is an internal marker; it must not reach the
    // CLI, which switches on `status`.
    await expect(res.json()).resolves.toEqual({
      status: 'PENDING',
      interval: 5,
    });
  });

  it('returns 429 with Retry-After when polling too fast', async () => {
    exchangeToken.mockResolvedValue({
      status: 'SLOW_DOWN',
      interval: 5,
      slowDown: true,
    });

    const res = await post();

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    await expect(res.json()).resolves.toEqual({
      status: 'SLOW_DOWN',
      interval: 5,
    });
  });

  it('surfaces a denied session as 403 and an expired one as 410', async () => {
    exchangeToken.mockRejectedValueOnce(
      new ForbiddenException({ status: 'DENIED', message: 'denied' }),
    );
    expect((await post()).status).toBe(403);

    exchangeToken.mockRejectedValueOnce(
      new GoneException({ status: 'EXPIRED', message: 'expired' }),
    );
    expect((await post()).status).toBe(410);
  });

  it('surfaces a bad secret as 401', async () => {
    exchangeToken.mockRejectedValue(
      new UnauthorizedException('Invalid session'),
    );

    expect((await post()).status).toBe(401);
  });

  it('rejects a malformed body before it reaches the service', async () => {
    const res = await post({ sessionId: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(exchangeToken).not.toHaveBeenCalled();
  });
});
