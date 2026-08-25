import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CliAuthMode, CliAuthStatus } from '@prisma/client';
import { CliAuthService } from '../cli-auth.service';
import { OtpAttemptTrackerService } from '../../otp-attempt-tracker.service';
import { CreateCliSessionDto } from '../dto/cli-auth.dto';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Row[]).some((clause) => matches(row, clause));
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date)
    ) {
      if ('lt' in value) return row[key] < value.lt;
      if ('gte' in value) return row[key] >= value.gte;
    }
    return row[key] === value;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      row[key] = (row[key] ?? 0) + (value as any).increment;
    } else {
      row[key] = value;
    }
  }
}

/** Minimal in-memory stand-in for one Prisma model delegate. */
class FakeTable {
  rows: Row[] = [];
  private seq = 0;

  constructor(
    private readonly defaults: Row,
    private readonly uniqueKeys: string[],
  ) {}

  create = async ({ data }: { data: Row }) => {
    for (const key of this.uniqueKeys) {
      if (
        data[key] !== undefined &&
        data[key] !== null &&
        this.rows.some((r) => r[key] === data[key])
      ) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        error.name = 'PrismaClientKnownRequestError';
        throw error;
      }
    }
    const row: Row = {
      id: `row_${(this.seq += 1)}`,
      createdAt: new Date(),
      ...this.defaults,
      ...data,
    };
    this.rows.push(row);
    return { ...row };
  };

  findUnique = async ({ where }: { where: Row }) => {
    const row = this.rows.find((r) => matches(r, where));
    return row ? { ...row } : null;
  };

  findFirst = async ({ where }: { where: Row }) => {
    const row = this.rows.find((r) => matches(r, where));
    return row ? { ...row } : null;
  };

  findMany = async ({ where }: { where: Row }) => {
    return this.rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
  };

  update = async ({ where, data }: { where: Row; data: Row }) => {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw new Error('record not found in fake table');
    applyData(row, data);
    return { ...row };
  };

  updateMany = async ({ where, data }: { where: Row; data: Row }) => {
    const hits = this.rows.filter((r) => matches(r, where));
    hits.forEach((row) => applyData(row, data));
    return { count: hits.length };
  };

  deleteMany = async ({ where }: { where: Row }) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { count: before - this.rows.length };
  };
}

function buildService(overrides: Record<string, string | undefined> = {}) {
  const cliAuthSession = new FakeTable(
    {
      status: CliAuthStatus.PENDING,
      pollCount: 0,
      lastPolledAt: null,
      userId: null,
      userCode: null,
      redirectUri: null,
      state: null,
      authorizationCodeHash: null,
      authorizationCodeExpiresAt: null,
      cliTokenId: null,
    },
    ['userCode'],
  );
  const cliToken = new FakeTable(
    {
      revokedAt: null,
      revokedReason: null,
      previousRefreshTokenHash: null,
      rotatedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdIp: null,
    },
    ['refreshTokenHash', 'previousRefreshTokenHash'],
  );

  const user = {
    findUnique: async ({ where }: { where: Row }) =>
      where.id === 'user_1'
        ? {
            id: 'user_1',
            email: 'dev@example.com',
            name: 'Dev',
            role: 'USER',
            isDisabled: false,
            tokenVersion: 0,
          }
        : null,
  };

  const prisma = { cliAuthSession, cliToken, user } as any;
  const jwtService = { sign: jest.fn(() => 'signed.jwt.token') } as any;

  const config: Record<string, string | undefined> = {
    FRONTEND_URL: 'https://www.goalslot.io',
    ...overrides,
  };
  const configService = { get: (key: string) => config[key] } as any;

  const service = new CliAuthService(
    prisma,
    jwtService,
    configService,
    new OtpAttemptTrackerService(),
  );

  return { service, prisma, cliAuthSession, cliToken, jwtService };
}

// PKCE pair used across the loopback tests.
const CODE_VERIFIER = randomBytes(32).toString('base64url');
const CODE_CHALLENGE = createHash('sha256')
  .update(CODE_VERIFIER, 'ascii')
  .digest('base64url');

function loopbackDto(
  overrides: Partial<CreateCliSessionDto> = {},
): CreateCliSessionDto {
  return {
    mode: CliAuthMode.LOOPBACK,
    redirectUri: 'http://127.0.0.1:53412/callback',
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: 'S256',
    clientName: 'goalslot-cli',
    clientVersion: '0.1.0',
    deviceLabel: 'ZEESHAN-DESK',
    platform: 'win32-x64',
    ...overrides,
  } as CreateCliSessionDto;
}

function deviceDto(): CreateCliSessionDto {
  return {
    mode: CliAuthMode.DEVICE,
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: 'S256',
    clientName: 'goalslot-cli',
    clientVersion: '0.1.0',
    deviceLabel: 'vps-01',
    platform: 'linux-x64',
  } as CreateCliSessionDto;
}

// ---------------------------------------------------------------------------

describe('CliAuthService loopback flow', () => {
  it('runs the happy path: create, approve, exchange', async () => {
    const { service, cliToken } = buildService();

    const created = await service.createSession(
      loopbackDto({ state: 'abcd1234efgh' }),
      '203.0.113.9',
      'goalslot-cli/0.1.0',
    );

    expect(created.sessionSecret).toMatch(/^gsl_ss_/);
    expect(created).toHaveProperty(
      'approvalUrl',
      `https://www.goalslot.io/cli/authorize?session=${created.sessionId}`,
    );

    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );
    expect(approved.status).toBe(CliAuthStatus.APPROVED);
    expect(approved.authorizationCode).toMatch(/^gsl_ac_/);
    // The API composes the redirect from the stored URI; the web app never
    // concatenates it.
    expect(approved.redirectUri).toContain('http://127.0.0.1:53412/callback?');
    expect(approved.redirectUri).toContain('state=abcd1234efgh');

    const exchanged: any = await service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
      authorizationCode: approved.authorizationCode,
    });

    expect(exchanged.tokenType).toBe('Bearer');
    expect(exchanged.accessToken).toBe('signed.jwt.token');
    expect(exchanged.refreshToken).toMatch(/^gsl_rt_/);
    expect(exchanged.scopes).toEqual(['full']);
    expect(exchanged.user).toEqual({
      id: 'user_1',
      email: 'dev@example.com',
      name: 'Dev',
    });

    // The stored row keeps only a digest of the refresh token.
    expect(cliToken.rows[0].refreshTokenHash).not.toContain(
      exchanged.refreshToken,
    );
  });

  it('mints the access token with typ cli, the cid and the scopes', async () => {
    // Without typ: 'cli' the token would be an ordinary web access token, and
    // JwtRefreshStrategy's untyped-token allowance would let it be traded for a
    // 30-day web pair. Without cid there is nothing to revoke against.
    const { service, jwtService, cliToken } = buildService();

    const created = await service.createSession(loopbackDto());
    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );
    await service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
      authorizationCode: approved.authorizationCode,
    });

    expect(jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user_1',
        typ: 'cli',
        cid: cliToken.rows[0].id,
        scopes: ['full'],
        tokenVersion: 0,
      }),
      expect.objectContaining({ expiresIn: '1h' }),
    );
  });

  it('rejects a second exchange of the same authorization code', async () => {
    const { service } = buildService();

    const created = await service.createSession(loopbackDto());
    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );
    const exchange = () =>
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: CODE_VERIFIER,
        authorizationCode: approved.authorizationCode,
      });

    await exchange();
    await expect(exchange()).rejects.toThrow(GoneException);
  });

  it('burns the session when a wrong authorization code is presented', async () => {
    // A wrong code against an approved session is not a typo - the real CLI was
    // handed the code - so the session is consumed rather than left retryable.
    const { service, cliAuthSession } = buildService();

    const created = await service.createSession(loopbackDto());
    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );

    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: CODE_VERIFIER,
        authorizationCode: 'gsl_ac_definitely-not-the-real-code',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(cliAuthSession.rows[0].status).toBe(CliAuthStatus.CONSUMED);

    // And the genuine code is now useless too, which is the point.
    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: CODE_VERIFIER,
        authorizationCode: approved.authorizationCode,
      }),
    ).rejects.toThrow(GoneException);
  });

  it('rejects an exchange whose PKCE verifier does not match', async () => {
    const { service } = buildService();

    const created = await service.createSession(loopbackDto());
    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );

    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: randomBytes(32).toString('base64url'),
        authorizationCode: approved.authorizationCode,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an exchange with the wrong session secret', async () => {
    const { service } = buildService();

    const created = await service.createSession(loopbackDto());
    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );

    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: `gsl_ss_${randomBytes(32).toString('base64url')}`,
        codeVerifier: CODE_VERIFIER,
        authorizationCode: approved.authorizationCode,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an unknown session id the same way as a bad secret', async () => {
    const { service } = buildService();

    await expect(
      service.exchangeToken({
        sessionId: '00000000-0000-4000-8000-000000000000',
        sessionSecret: `gsl_ss_${randomBytes(32).toString('base64url')}`,
        codeVerifier: CODE_VERIFIER,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it.each([
    ['a public https origin', 'https://evil.example.com/callback'],
    ['a public http origin', 'http://evil.example.com/callback'],
    [
      'a host that merely starts with the loopback IP',
      'http://127.0.0.1.evil.com/callback',
    ],
    ['IPv6 loopback', 'http://[::1]:53412/callback'],
    ['a non-callback path', 'http://127.0.0.1:53412/steal'],
    [
      'a query string',
      'http://127.0.0.1:53412/callback?next=https://evil.example.com',
    ],
    ['a fragment', 'http://127.0.0.1:53412/callback#x'],
    ['embedded userinfo', 'http://user:pass@127.0.0.1:53412/callback'],
    ['a privileged port', 'http://127.0.0.1:80/callback'],
    ['no port at all', 'http://127.0.0.1/callback'],
    ['a non-http scheme', 'file:///callback'],
    ['not a URL at all', 'not-a-url'],
  ])('rejects a redirectUri with %s', async (_label, redirectUri) => {
    const { service, cliAuthSession } = buildService();

    await expect(
      service.createSession(loopbackDto({ redirectUri })),
    ).rejects.toThrow(BadRequestException);

    // Nothing is persisted for a rejected redirect target.
    expect(cliAuthSession.rows).toHaveLength(0);
  });

  it('accepts localhost as a compatibility fallback for 127.0.0.1', async () => {
    const { service } = buildService();

    await expect(
      service.createSession(
        loopbackDto({ redirectUri: 'http://localhost:53412/callback' }),
      ),
    ).resolves.toHaveProperty('sessionId');
  });

  it('never echoes the rejected redirectUri back to the caller', async () => {
    const { service } = buildService();
    const redirectUri = 'https://evil.example.com/callback';

    await expect(
      service.createSession(loopbackDto({ redirectUri })),
    ).rejects.toThrow('Invalid redirectUri');

    await service
      .createSession(loopbackDto({ redirectUri }))
      .catch((error: Error) => {
        expect(error.message).not.toContain('evil.example.com');
      });
  });
});

describe('CliAuthService expiry', () => {
  it('refuses to exchange an expired session', async () => {
    const { service, cliAuthSession } = buildService({
      CLI_SESSION_TTL_SECONDS: '600',
    });

    const created = await service.createSession(loopbackDto());
    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );

    cliAuthSession.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: CODE_VERIFIER,
        authorizationCode: approved.authorizationCode,
      }),
    ).rejects.toThrow(GoneException);
  });

  it('refuses to exchange once the 60s authorization code has lapsed', async () => {
    const { service, cliAuthSession } = buildService();

    const created = await service.createSession(loopbackDto());
    const approved: any = await service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );

    cliAuthSession.rows[0].authorizationCodeExpiresAt = new Date(
      Date.now() - 1000,
    );

    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: CODE_VERIFIER,
        authorizationCode: approved.authorizationCode,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses to approve an expired session', async () => {
    const { service, cliAuthSession } = buildService();

    const created = await service.createSession(loopbackDto());
    cliAuthSession.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(
      service.approveSession(created.sessionId, 'user_1', {}),
    ).rejects.toThrow(GoneException);
  });

  it('hides an expired session from the approval page as 410', async () => {
    const { service, cliAuthSession } = buildService();

    const created = await service.createSession(loopbackDto());
    cliAuthSession.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(service.getSessionMetadata(created.sessionId)).rejects.toThrow(
      GoneException,
    );
  });

  it('honours CLI_SESSION_TTL_SECONDS and falls back to 600 on garbage', async () => {
    const custom = buildService({ CLI_SESSION_TTL_SECONDS: '120' });
    await expect(
      custom.service.createSession(loopbackDto()),
    ).resolves.toHaveProperty('expiresIn', 120);

    // A typo in the deploy environment must degrade to the default, not
    // produce a zero-second TTL that breaks every login.
    const broken = buildService({ CLI_SESSION_TTL_SECONDS: 'soon' });
    await expect(
      broken.service.createSession(loopbackDto()),
    ).resolves.toHaveProperty('expiresIn', 600);
  });
});

describe('CliAuthService approve and deny', () => {
  it('returns 409 when a session is approved twice', async () => {
    const { service } = buildService();

    const created = await service.createSession(loopbackDto());
    await service.approveSession(created.sessionId, 'user_1', {});

    await expect(
      service.approveSession(created.sessionId, 'user_1', {}),
    ).rejects.toThrow(ConflictException);
  });

  it('reports a denied session as 403 to the polling CLI', async () => {
    const { service } = buildService();

    const created = await service.createSession(loopbackDto());
    await expect(
      service.denySession(created.sessionId, 'user_1'),
    ).resolves.toEqual({ status: CliAuthStatus.DENIED });

    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: CODE_VERIFIER,
        authorizationCode: 'gsl_ac_whatever',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses to grant a scope the CLI did not request', async () => {
    const { service } = buildService();
    const created = await service.createSession(loopbackDto());

    await expect(
      service.approveSession(created.sessionId, 'user_1', {
        scopes: ['full', 'admin'],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s for an unknown session id', async () => {
    const { service } = buildService();

    await expect(
      service.approveSession(
        '00000000-0000-4000-8000-000000000000',
        'user_1',
        {},
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('CliAuthService device flow', () => {
  it('issues a formatted user code and a verification URI', async () => {
    const { service } = buildService();

    const created: any = await service.createSession(deviceDto());

    expect(created.userCode).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(created.verificationUri).toBe(
      'https://www.goalslot.io/cli/authorize',
    );
    expect(created.verificationUriComplete).toBe(
      `https://www.goalslot.io/cli/authorize?user_code=${created.userCode}`,
    );
    expect(created.interval).toBe(5);
  });

  it('reports PENDING to a poll before approval, then issues on approval', async () => {
    const { service, cliAuthSession } = buildService();

    const created: any = await service.createSession(deviceDto());

    const first: any = await service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
    });
    expect(first).toEqual({ status: 'PENDING', interval: 5, pending: true });

    await service.approveSession(created.sessionId, 'user_1', {});

    // Move the last poll back so the interval check does not fire.
    cliAuthSession.rows[0].lastPolledAt = new Date(Date.now() - 10_000);

    const second: any = await service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
    });
    expect(second.accessToken).toBe('signed.jwt.token');
    // Device mode never mints an authorization code, so none is required.
    expect(second.refreshToken).toMatch(/^gsl_rt_/);
  });

  it('answers SLOW_DOWN when polled faster than the advertised interval', async () => {
    const { service } = buildService();
    const created: any = await service.createSession(deviceDto());

    await service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
    });
    const second: any = await service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
    });

    expect(second).toEqual({
      status: 'SLOW_DOWN',
      interval: 5,
      slowDown: true,
    });
  });

  it('force-expires a session that has been polled into the ground', async () => {
    const { service, cliAuthSession } = buildService();
    const created: any = await service.createSession(deviceDto());

    cliAuthSession.rows[0].pollCount = 500;

    await expect(
      service.exchangeToken({
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        codeVerifier: CODE_VERIFIER,
      }),
    ).rejects.toThrow(GoneException);
    expect(cliAuthSession.rows[0].status).toBe(CliAuthStatus.EXPIRED);
  });

  it('resolves a user code typed in lower case without the dash', async () => {
    const { service } = buildService();
    const created: any = await service.createSession(deviceDto());

    const found = await service.lookupByUserCode(
      created.userCode.replace('-', '').toLowerCase(),
      'user_1',
    );

    expect(found.sessionId).toBe(created.sessionId);
    expect(found.deviceLabel).toBe('vps-01');
    expect(found.mode).toBe(CliAuthMode.DEVICE);
  });

  it('locks a user out after five wrong device codes', async () => {
    const { service } = buildService();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.lookupByUserCode('2345-6789', 'user_1'),
      ).rejects.toThrow(NotFoundException);
    }

    // The fifth failure trips the lockout, and every attempt after it is
    // refused without touching the table.
    await expect(
      service.lookupByUserCode('2345-6789', 'user_1'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.lookupByUserCode('2345-6789', 'user_1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('gives an expired code the same answer as an unknown one', async () => {
    // Distinguishing them would tell an attacker when a guess was real.
    const { service, cliAuthSession } = buildService();
    const created: any = await service.createSession(deviceDto());
    cliAuthSession.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(
      service.lookupByUserCode(created.userCode, 'user_1'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.lookupByUserCode('2345-6789', 'user_2'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('CliAuthService refresh token rotation', () => {
  async function issue() {
    const built = buildService();
    const created = await built.service.createSession(loopbackDto());
    const approved: any = await built.service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );
    const issued: any = await built.service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
      authorizationCode: approved.authorizationCode,
    });
    return { ...built, issued };
  }

  it('rotates the refresh token and keeps the token id stable', async () => {
    const { service, issued } = await issue();

    const rotated: any = await service.refresh(issued.refreshToken, '10.0.0.1');

    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.tokenId).toBe(issued.tokenId);
  });

  it('revokes the whole credential when a rotated-away token is replayed', async () => {
    const { service, issued, cliToken } = await issue();

    const rotated: any = await service.refresh(issued.refreshToken);

    // Replaying the old token means it exists in two places. Kill the row.
    await expect(service.refresh(issued.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(cliToken.rows[0].revokedReason).toBe('REUSE_DETECTED');

    // And the token the legitimate CLI holds is dead too, by design.
    await expect(service.refresh(rotated.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a revoked token', async () => {
    const { service, issued, cliToken } = await issue();

    cliToken.rows[0].revokedAt = new Date();
    cliToken.rows[0].revokedReason = 'USER';

    await expect(service.refresh(issued.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an expired token', async () => {
    const { service, issued, cliToken } = await issue();

    cliToken.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(service.refresh(issued.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('never slides the expiry past the absolute ceiling', async () => {
    const { service, issued, cliToken } = await issue();

    const ceiling = new Date(Date.now() + 60_000);
    cliToken.rows[0].absoluteExpiresAt = ceiling;

    const rotated: any = await service.refresh(issued.refreshToken);

    expect(new Date(rotated.refreshTokenExpiresAt).getTime()).toBe(
      ceiling.getTime(),
    );
  });

  it('refuses an unknown refresh token', async () => {
    const { service } = buildService();

    await expect(service.refresh('gsl_rt_nope')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('CliAuthService token management', () => {
  async function issue() {
    const built = buildService();
    const created = await built.service.createSession(loopbackDto());
    const approved: any = await built.service.approveSession(
      created.sessionId,
      'user_1',
      {},
    );
    const issued: any = await built.service.exchangeToken({
      sessionId: created.sessionId,
      sessionSecret: created.sessionSecret,
      codeVerifier: CODE_VERIFIER,
      authorizationCode: approved.authorizationCode,
    });
    return { ...built, issued };
  }

  it('lists tokens without any token material', async () => {
    const { service, issued } = await issue();

    const [listed] = await service.listTokens('user_1');

    expect(listed.id).toBe(issued.tokenId);
    expect(listed.deviceLabel).toBe('ZEESHAN-DESK');
    expect(JSON.stringify(listed)).not.toContain(issued.refreshToken);
    expect(Object.keys(listed)).not.toContain('refreshTokenHash');
  });

  it('revokes a token and refuses the refresh that follows', async () => {
    const { service, issued } = await issue();

    await service.revokeToken('user_1', issued.tokenId);

    await expect(service.refresh(issued.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('will not let one account revoke or rename another account token', async () => {
    const { service, issued } = await issue();

    await expect(
      service.revokeToken('someone_else', issued.tokenId),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.renameToken('someone_else', issued.tokenId, 'mine now'),
    ).rejects.toThrow(NotFoundException);
  });

  it('revokes everything at once and reports the count', async () => {
    const { service, issued } = await issue();

    await expect(service.revokeAllTokens('user_1')).resolves.toEqual({
      revoked: 1,
    });
    // Already revoked, so a second sweep finds nothing.
    await expect(service.revokeAllTokens('user_1')).resolves.toEqual({
      revoked: 0,
    });
    expect(issued.tokenId).toBeDefined();
  });
});
