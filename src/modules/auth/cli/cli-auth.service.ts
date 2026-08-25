import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CliAuthMode, CliAuthStatus, CliToken, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OtpAttemptTrackerService } from '../otp-attempt-tracker.service';
import { resolveFrontendUrl } from '../google-oauth.config';
import { CliAuthConfig, getCliAuthConfig } from './cli-auth.config';
import { composeRedirectUri, isValidLoopbackRedirectUri } from './redirect-uri';
import {
  generateAuthorizationCode,
  generateRefreshToken,
  generateSessionSecret,
  generateUserCode,
  normalizeUserCode,
  safeHashEqual,
  sha256Hex,
  verifyPkceS256,
} from './cli-crypto';
import {
  ApproveCliSessionDto,
  CreateCliSessionDto,
  ExchangeCliTokenDto,
} from './dto/cli-auth.dto';

/** Authorization codes are single use and die 60s after approval. */
const AUTHORIZATION_CODE_TTL_MS = 60_000;

/** Device-flow poll interval advertised to the CLI, in seconds. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/**
 * A session polled this many times is not a CLI waiting for a human, it is a
 * script. Force-expire rather than keep answering.
 */
const MAX_POLL_COUNT = 200;

/** Brute-force budget for device code lookup, keyed per user id. */
const DEVICE_LOOKUP_PURPOSE = 'cli-device-lookup';
const MAX_DEVICE_LOOKUP_ATTEMPTS = 5;
const DEVICE_LOOKUP_LOCKOUT_MS = 900_000; // 15 minutes

/** Revoked tokens stay listed this long so the user can see what happened. */
const REVOKED_TOKEN_VISIBILITY_DAYS = 30;

const DAY_MS = 86_400_000;

export interface CliSessionMetadata {
  sessionId: string;
  mode: CliAuthMode;
  status: CliAuthStatus;
  clientName: string;
  clientVersion: string;
  deviceLabel: string;
  platform: string;
  scopes: string[];
  requestIp: string | null;
  requestedAt: Date;
  expiresAt: Date;
}

/**
 * CLI authorization: loopback (default) and device code, sharing one table, one
 * approval page and one token-exchange endpoint.
 *
 * Two independent secrets guard the flow and neither ever touches disk or the
 * browser: the PKCE codeVerifier and the sessionSecret. That is why a sessionId
 * appearing in browser history, on a shared screen, or in a server log is not a
 * compromise on its own - holding it lets you read nothing and exchange
 * nothing.
 */
@Injectable()
export class CliAuthService {
  private readonly logger = new Logger(CliAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly attemptTracker: OtpAttemptTrackerService,
  ) {}

  private get config(): CliAuthConfig {
    return getCliAuthConfig(this.configService);
  }

  // -------------------------------------------------------------------------
  // Session creation
  // -------------------------------------------------------------------------

  async createSession(
    dto: CreateCliSessionDto,
    requestIp?: string,
    requestUserAgent?: string,
  ) {
    if (dto.mode === CliAuthMode.LOOPBACK) {
      // Validated here, once, and then stored. Never re-read from request input
      // at approval time - see redirect-uri.ts for why that matters. The
      // submitted value is deliberately not echoed back: a caller probing the
      // allowlist learns only pass or fail.
      if (!isValidLoopbackRedirectUri(dto.redirectUri)) {
        throw new BadRequestException('Invalid redirectUri');
      }
    }

    const { sessionTtlSeconds } = this.config;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000);

    const sessionSecret = generateSessionSecret();
    const scopes = this.normalizeScopes(dto.scopes);

    const baseData: Prisma.CliAuthSessionUncheckedCreateInput = {
      mode: dto.mode,
      sessionSecretHash: sha256Hex(sessionSecret),
      codeChallenge: dto.codeChallenge,
      codeChallengeMethod: dto.codeChallengeMethod,
      redirectUri:
        dto.mode === CliAuthMode.LOOPBACK ? (dto.redirectUri as string) : null,
      state: dto.mode === CliAuthMode.LOOPBACK ? (dto.state ?? null) : null,
      clientName: dto.clientName,
      clientVersion: dto.clientVersion,
      deviceLabel: dto.deviceLabel,
      platform: dto.platform,
      scopes,
      requestIp: requestIp ?? null,
      // Truncated: user agents are caller-controlled and this column is only
      // ever read back for display on the approval card.
      requestUserAgent: requestUserAgent?.slice(0, 300) ?? null,
      expiresAt,
    };

    const session =
      dto.mode === CliAuthMode.DEVICE
        ? await this.createDeviceSession(baseData)
        : await this.prisma.cliAuthSession.create({ data: baseData });

    // Fire and forget. Pending sessions are disposable and short-lived, so
    // sweeping them on the one endpoint that creates them keeps the table
    // bounded without adding a cron for a table that holds tens of rows.
    void this.pruneExpiredSessions();

    const frontendUrl = resolveFrontendUrl(this.configService);

    if (session.mode === CliAuthMode.DEVICE) {
      const userCode = session.userCode as string;
      const verificationUri = `${frontendUrl}/cli/authorize`;
      return {
        sessionId: session.id,
        sessionSecret,
        userCode,
        verificationUri,
        // snake_case here on purpose: this is a URL a human may read out or
        // paste, and matching RFC 8628 on the query parameter costs nothing.
        verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
        expiresIn: sessionTtlSeconds,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      };
    }

    return {
      sessionId: session.id,
      sessionSecret,
      approvalUrl: `${frontendUrl}/cli/authorize?session=${encodeURIComponent(session.id)}`,
      expiresIn: sessionTtlSeconds,
    };
  }

  /**
   * Retries on the userCode unique constraint. With 30^8 codes and only the
   * handful live at any moment a collision is vanishingly unlikely, but
   * "vanishingly unlikely" applied to a login flow still means somebody
   * eventually sees a 500, so it is retried rather than assumed away.
   */
  private async createDeviceSession(
    baseData: Prisma.CliAuthSessionUncheckedCreateInput,
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.cliAuthSession.create({
          data: { ...baseData, userCode: generateUserCode() },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new BadRequestException(
      'Could not allocate a device code. Please try again.',
    );
  }

  private normalizeScopes(scopes?: string[]): string {
    if (!scopes || scopes.length === 0) return 'full';
    return Array.from(new Set(scopes)).sort().join(',');
  }

  private splitScopes(scopes: string): string[] {
    return scopes
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
  }

  private async pruneExpiredSessions(): Promise<void> {
    try {
      await this.prisma.cliAuthSession.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch (error) {
      // Never let housekeeping fail a login. A row that survives this sweep is
      // still expired everywhere it is read, so the only cost is table size.
      this.logger.warn(
        `CLI session prune failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Approval page reads
  // -------------------------------------------------------------------------

  /**
   * Metadata for the approval page. Behind JwtAuthGuard so a scraped sessionId
   * cannot be used anonymously to enumerate which machines are logging in.
   */
  async getSessionMetadata(sessionId: string): Promise<CliSessionMetadata> {
    const session = await this.prisma.cliAuthSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException('Authorization request not found');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('This authorization request has expired');
    }
    if (session.status !== CliAuthStatus.PENDING) {
      // 409 rather than 410 so the page can tell "already handled" apart from
      // "timed out" and show the right terminal copy.
      throw new ConflictException({
        status: session.status,
        message: 'This authorization request has already been resolved',
      });
    }

    return this.toMetadata(session);
  }

  async lookupByUserCode(
    userCode: string,
    userId: string,
  ): Promise<CliSessionMetadata> {
    if (this.attemptTracker.isLockedOut(userId, DEVICE_LOOKUP_PURPOSE)) {
      throw new BadRequestException(
        'Too many incorrect codes. Please try again in 15 minutes.',
      );
    }

    const normalized = normalizeUserCode(userCode);
    const session = normalized
      ? await this.prisma.cliAuthSession.findUnique({
          where: { userCode: normalized },
        })
      : null;

    // One response for malformed, unknown, expired and already-resolved codes.
    // Distinguishing them would turn this into an oracle telling an attacker
    // when a guess was "close" (real but expired), which is exactly the signal
    // that makes searching a 30^8 space worth prioritising.
    const usable =
      session !== null &&
      session.mode === CliAuthMode.DEVICE &&
      session.status === CliAuthStatus.PENDING &&
      session.expiresAt.getTime() > Date.now();

    if (!usable) {
      const { lockedOut } = this.attemptTracker.recordFailedAttempt(
        userId,
        DEVICE_LOOKUP_PURPOSE,
        MAX_DEVICE_LOOKUP_ATTEMPTS,
        DEVICE_LOOKUP_LOCKOUT_MS,
        DEVICE_LOOKUP_LOCKOUT_MS,
      );
      if (lockedOut) {
        throw new BadRequestException(
          'Too many incorrect codes. Please try again in 15 minutes.',
        );
      }
      throw new NotFoundException('That code is not valid');
    }

    this.attemptTracker.reset(userId, DEVICE_LOOKUP_PURPOSE);
    return this.toMetadata(session);
  }

  private toMetadata(session: {
    id: string;
    mode: CliAuthMode;
    status: CliAuthStatus;
    clientName: string;
    clientVersion: string;
    deviceLabel: string;
    platform: string;
    scopes: string;
    requestIp: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): CliSessionMetadata {
    return {
      sessionId: session.id,
      mode: session.mode,
      status: session.status,
      clientName: session.clientName,
      clientVersion: session.clientVersion,
      deviceLabel: session.deviceLabel,
      platform: session.platform,
      scopes: this.splitScopes(session.scopes),
      requestIp: session.requestIp,
      requestedAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  // -------------------------------------------------------------------------
  // Approve and deny
  // -------------------------------------------------------------------------

  async approveSession(
    sessionId: string,
    userId: string,
    dto: ApproveCliSessionDto,
  ) {
    const session = await this.loadPendingForDecision(sessionId);

    const requested = this.splitScopes(session.scopes);
    const granted =
      dto.scopes && dto.scopes.length > 0
        ? Array.from(new Set(dto.scopes)).sort()
        : requested;

    // Approving more than the CLI asked for would silently widen the grant past
    // what the approval card described to the user.
    const widened = granted.filter((scope) => !requested.includes(scope));
    if (widened.length > 0) {
      throw new BadRequestException(
        'Granted scopes must be a subset of the requested scopes',
      );
    }

    const now = new Date();
    const authorizationCode =
      session.mode === CliAuthMode.LOOPBACK
        ? generateAuthorizationCode()
        : null;

    // Conditional on status so two tabs racing the Approve button cannot both
    // mint a code; the loser updates zero rows and gets the 409.
    const updated = await this.prisma.cliAuthSession.updateMany({
      where: { id: sessionId, status: CliAuthStatus.PENDING },
      data: {
        status: CliAuthStatus.APPROVED,
        userId,
        approvedAt: now,
        scopes: granted.join(','),
        authorizationCodeHash: authorizationCode
          ? sha256Hex(authorizationCode)
          : null,
        authorizationCodeExpiresAt: authorizationCode
          ? new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS)
          : null,
      },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        'This authorization request has already been resolved',
      );
    }

    if (session.mode === CliAuthMode.LOOPBACK) {
      // The API composes the redirect from the stored, already-validated URI.
      // The web app never concatenates it, and there is no HTTP 3xx anywhere in
      // this flow - the browser navigates client-side to this string.
      return {
        status: CliAuthStatus.APPROVED,
        redirectUri: composeRedirectUri(
          session.redirectUri as string,
          authorizationCode as string,
          session.state ?? undefined,
        ),
        // Surfaced so the page can offer a copyable fallback when the loopback
        // listener died before the browser could reach it.
        authorizationCode: authorizationCode as string,
      };
    }

    return { status: CliAuthStatus.APPROVED };
  }

  async denySession(sessionId: string, userId: string) {
    await this.loadPendingForDecision(sessionId);

    const updated = await this.prisma.cliAuthSession.updateMany({
      where: { id: sessionId, status: CliAuthStatus.PENDING },
      data: { status: CliAuthStatus.DENIED, userId, deniedAt: new Date() },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        'This authorization request has already been resolved',
      );
    }

    return { status: CliAuthStatus.DENIED };
  }

  private async loadPendingForDecision(sessionId: string) {
    const session = await this.prisma.cliAuthSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException('Authorization request not found');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('This authorization request has expired');
    }
    if (session.status !== CliAuthStatus.PENDING) {
      throw new ConflictException(
        'This authorization request has already been resolved',
      );
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // Token exchange (loopback) and poll (device)
  // -------------------------------------------------------------------------

  async exchangeToken(dto: ExchangeCliTokenDto, requestIp?: string) {
    const session = await this.prisma.cliAuthSession.findUnique({
      where: { id: dto.sessionId },
    });

    // 401 rather than 404: an unknown id and a wrong secret have to be
    // indistinguishable, or this endpoint confirms which session ids exist.
    if (!session) {
      throw new UnauthorizedException('Invalid session');
    }
    if (
      !safeHashEqual(session.sessionSecretHash, sha256Hex(dto.sessionSecret))
    ) {
      throw new UnauthorizedException('Invalid session');
    }

    const now = new Date();

    if (session.mode === CliAuthMode.DEVICE) {
      if (session.pollCount + 1 > MAX_POLL_COUNT) {
        await this.prisma.cliAuthSession.updateMany({
          where: { id: session.id, status: CliAuthStatus.PENDING },
          data: { status: CliAuthStatus.EXPIRED },
        });
        throw new GoneException({
          status: 'EXPIRED',
          message: 'This authorization request has expired',
        });
      }
      const throttled = await this.recordPoll(session.id, session.lastPolledAt);
      if (throttled) return throttled;
    }

    if (session.status === CliAuthStatus.DENIED) {
      throw new ForbiddenException({
        status: 'DENIED',
        message: 'The authorization request was denied',
      });
    }

    if (
      session.status === CliAuthStatus.CONSUMED ||
      session.status === CliAuthStatus.EXPIRED ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw new GoneException({
        status: 'EXPIRED',
        message: 'This authorization request has expired',
      });
    }

    if (session.status === CliAuthStatus.PENDING) {
      // 202, not RFC 8628's `400 authorization_pending`. Polling is the normal
      // case here, and shipping it as a 4xx makes every HTTP client, log line
      // and error-tracking rule treat the happy path as a failure.
      return {
        status: 'PENDING' as const,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
        pending: true as const,
      };
    }

    if (session.mode === CliAuthMode.LOOPBACK) {
      const codeValid =
        typeof dto.authorizationCode === 'string' &&
        session.authorizationCodeExpiresAt !== null &&
        session.authorizationCodeExpiresAt.getTime() > now.getTime() &&
        safeHashEqual(
          session.authorizationCodeHash,
          sha256Hex(dto.authorizationCode),
        );

      if (!codeValid) {
        // A wrong code against an approved session is not a typo - the real CLI
        // was handed the code. Burn the session rather than let it be retried.
        await this.burn(session.id);
        throw new UnauthorizedException('Invalid authorization code');
      }
    }

    if (!verifyPkceS256(dto.codeVerifier, session.codeChallenge)) {
      await this.burn(session.id);
      throw new UnauthorizedException('PKCE verification failed');
    }

    // The atomic consume. Two concurrent exchanges both reach here; exactly one
    // sees count === 1 and mints a token, the other gets 410.
    const consumed = await this.prisma.cliAuthSession.updateMany({
      where: { id: session.id, status: CliAuthStatus.APPROVED },
      data: { status: CliAuthStatus.CONSUMED, consumedAt: now },
    });
    if (consumed.count === 0) {
      throw new GoneException({
        status: 'EXPIRED',
        message: 'This authorization request has already been used',
      });
    }

    const userId = session.userId;
    if (!userId) {
      // Cannot happen - the same update that sets APPROVED sets userId - but
      // minting a credential against a null owner is not a failure mode worth
      // leaving to chance.
      throw new UnauthorizedException('Invalid session');
    }

    const issued = await this.issueToken({
      userId,
      scopes: session.scopes,
      clientName: session.clientName,
      clientVersion: session.clientVersion,
      deviceLabel: session.deviceLabel,
      platform: session.platform,
      createdIp: requestIp,
    });

    await this.prisma.cliAuthSession.update({
      where: { id: session.id },
      data: { cliTokenId: issued.tokenId },
    });

    return issued;
  }

  /**
   * Enforces the advertised poll interval server-side. Returns a SLOW_DOWN
   * payload when the caller is early, otherwise records the poll and returns
   * null.
   */
  private async recordPoll(
    sessionId: string,
    lastPolledAt: Date | null,
  ): Promise<{
    status: 'SLOW_DOWN';
    interval: number;
    slowDown: true;
  } | null> {
    const now = Date.now();
    // interval - 1s of slack, so a CLI sleeping exactly `interval` is never
    // punished for clock jitter or request latency.
    const minGapMs = (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000;
    if (lastPolledAt && now - lastPolledAt.getTime() < minGapMs) {
      return {
        status: 'SLOW_DOWN',
        interval: DEVICE_POLL_INTERVAL_SECONDS,
        slowDown: true,
      };
    }
    await this.prisma.cliAuthSession.update({
      where: { id: sessionId },
      data: { lastPolledAt: new Date(now), pollCount: { increment: 1 } },
    });
    return null;
  }

  private async burn(sessionId: string): Promise<void> {
    await this.prisma.cliAuthSession.updateMany({
      where: { id: sessionId, status: CliAuthStatus.APPROVED },
      data: { status: CliAuthStatus.CONSUMED, consumedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Token minting and refresh
  // -------------------------------------------------------------------------

  private async issueToken(params: {
    userId: string;
    scopes: string;
    clientName: string;
    clientVersion: string;
    deviceLabel: string;
    platform: string;
    createdIp?: string;
  }) {
    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isDisabled: true,
        tokenVersion: true,
      },
    });
    if (!user || user.isDisabled) {
      throw new UnauthorizedException('Account not found or disabled');
    }

    const { refreshTokenDays, refreshTokenAbsoluteDays } = this.config;
    const now = new Date();
    const refreshToken = generateRefreshToken();

    const token = await this.prisma.cliToken.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256Hex(refreshToken),
        name: params.deviceLabel,
        clientName: params.clientName,
        clientVersion: params.clientVersion,
        deviceLabel: params.deviceLabel,
        platform: params.platform,
        scopes: params.scopes,
        createdIp: params.createdIp ?? null,
        expiresAt: new Date(now.getTime() + refreshTokenDays * DAY_MS),
        absoluteExpiresAt: new Date(
          now.getTime() + refreshTokenAbsoluteDays * DAY_MS,
        ),
      },
    });

    return this.buildTokenResponse(token, refreshToken, user);
  }

  private buildTokenResponse(
    token: CliToken,
    refreshToken: string,
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      tokenVersion: number;
    },
  ) {
    const { accessTokenTtl } = this.config;

    // `typ: 'cli'` is what keeps this token in its lane. JwtRefreshStrategy
    // already rejects any typ that is not 'refresh', so a CLI access token
    // cannot be presented at POST /auth/refresh to mint a 30-day *web* pair,
    // which would have made this whole revocable-token design decorative.
    // `cid` points at the CliToken row so JwtStrategy can honour a revoke
    // without waiting for the JWT to expire, and `tokenVersion` keeps a
    // password change killing CLI access tokens the same way it kills web ones.
    const accessToken = this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tokenVersion: user.tokenVersion,
        typ: 'cli',
        cid: token.id,
        scopes: this.splitScopes(token.scopes),
      },
      { expiresIn: accessTokenTtl },
    );

    return {
      tokenType: 'Bearer' as const,
      accessToken,
      expiresIn: this.ttlToSeconds(accessTokenTtl),
      refreshToken,
      refreshTokenExpiresAt: token.expiresAt,
      tokenId: token.id,
      scopes: this.splitScopes(token.scopes),
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /** Converts the JWT `expiresIn` string into the seconds the CLI is told. */
  private ttlToSeconds(ttl: string): number {
    const match = /^(\d+)\s*([smhd])?$/.exec(ttl.trim());
    if (!match) return 3600;
    const value = Number(match[1]);
    const unit = match[2] ?? 's';
    const multiplier: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86_400,
    };
    return value * (multiplier[unit] ?? 1);
  }

  async refresh(refreshToken: string, requestIp?: string) {
    const hash = sha256Hex(refreshToken);

    const token = await this.prisma.cliToken.findFirst({
      where: {
        OR: [{ refreshTokenHash: hash }, { previousRefreshTokenHash: hash }],
      },
    });
    if (!token) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (token.revokedAt) {
      throw new UnauthorizedException('Token revoked');
    }

    // Reuse detection. The presented token was already rotated away, which
    // means either the legitimate CLI is replaying (it should not - rotation is
    // synchronous) or somebody else has a copy. Both get the same answer: kill
    // the credential. The real CLI then fails on its next call and the user
    // re-runs `goalslot login`, which is the correct outcome for a credential
    // that may be in two places at once.
    if (!safeHashEqual(token.refreshTokenHash, hash)) {
      await this.prisma.cliToken.update({
        where: { id: token.id },
        data: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' },
      });
      throw new UnauthorizedException('Token revoked');
    }

    const now = new Date();
    if (
      token.expiresAt.getTime() <= now.getTime() ||
      token.absoluteExpiresAt.getTime() <= now.getTime()
    ) {
      throw new UnauthorizedException('Token expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: token.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isDisabled: true,
        tokenVersion: true,
      },
    });
    if (!user || user.isDisabled) {
      throw new UnauthorizedException('Account not found or disabled');
    }

    const nextRefreshToken = generateRefreshToken();
    const { refreshTokenDays } = this.config;

    // Sliding, but never past the absolute ceiling: a token refreshed daily for
    // a year still dies on its first birthday.
    const slidingExpiry = new Date(now.getTime() + refreshTokenDays * DAY_MS);
    const expiresAt =
      slidingExpiry.getTime() < token.absoluteExpiresAt.getTime()
        ? slidingExpiry
        : token.absoluteExpiresAt;

    const rotated = await this.prisma.cliToken.update({
      where: { id: token.id },
      data: {
        previousRefreshTokenHash: token.refreshTokenHash,
        refreshTokenHash: sha256Hex(nextRefreshToken),
        rotatedAt: now,
        expiresAt,
        lastUsedAt: now,
        lastUsedIp: requestIp ?? null,
      },
    });

    return this.buildTokenResponse(rotated, nextRefreshToken, user);
  }

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  async listTokens(userId: string) {
    const cutoff = new Date(
      Date.now() - REVOKED_TOKEN_VISIBILITY_DAYS * DAY_MS,
    );

    const tokens = await this.prisma.cliToken.findMany({
      where: {
        userId,
        // Recently revoked tokens stay listed so a REUSE_DETECTED revocation is
        // something the user can see and act on, rather than a row that
        // silently vanished from the list.
        OR: [{ revokedAt: null }, { revokedAt: { gte: cutoff } }],
      },
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    });

    // Never returns token material, hashed or otherwise.
    return tokens.map((token) => ({
      id: token.id,
      name: token.name,
      clientName: token.clientName,
      clientVersion: token.clientVersion,
      deviceLabel: token.deviceLabel,
      platform: token.platform,
      scopes: this.splitScopes(token.scopes),
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      lastUsedIp: token.lastUsedIp,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
      revokedReason: token.revokedReason,
    }));
  }

  async renameToken(userId: string, tokenId: string, name: string) {
    // updateMany, not update, so ownership is part of the WHERE clause rather
    // than a separate read somebody could later forget to make.
    const updated = await this.prisma.cliToken.updateMany({
      where: { id: tokenId, userId },
      data: { name },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Token not found');
    }
    return { id: tokenId, name };
  }

  async revokeToken(userId: string, tokenId: string) {
    const revoked = await this.prisma.cliToken.updateMany({
      where: { id: tokenId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'USER' },
    });
    if (revoked.count === 0) {
      throw new NotFoundException('Token not found');
    }
  }

  async revokeAllTokens(userId: string) {
    const revoked = await this.prisma.cliToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'USER' },
    });
    return { revoked: revoked.count };
  }
}
