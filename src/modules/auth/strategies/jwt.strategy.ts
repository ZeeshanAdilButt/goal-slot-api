import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../shared/types/authenticated-request.interface';

/**
 * How long a CLI token's revocation status is cached, in milliseconds.
 *
 * This is the whole cost/latency trade for CLI revocation: one extra DB read
 * per CLI token per minute, in exchange for "Revoke" in Settings taking effect
 * within roughly a minute instead of waiting out the access token's 1h life.
 * Reading the row on every request would be correct too, but it puts a query on
 * the hot path of every CLI call for a button most users press once a year.
 */
const CLI_TOKEN_CACHE_TTL_MS = 60_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: {
    sub: string;
    tokenVersion?: number;
    typ?: string;
    cid?: string;
    scopes?: string[];
    [claim: string]: unknown;
  }): Promise<AuthenticatedUser> {
    // Refresh tokens are minted with the same secret and an otherwise
    // identical payload, so without this check they authenticate every
    // API route just as well as an access token does -- turning a stolen
    // refresh token into a 30-day (rather than 7-day) full-access
    // credential. Only the `typ` claim distinguishes them.
    //
    // A missing `typ` is deliberately still accepted: tokens minted
    // before this claim existed carry none, and rejecting them would log
    // out every live session the moment this deploys. Those tokens all
    // expire within 7 days (JWT_EXPIRATION) of the deploy, after which
    // only the refresh-token side of the transition remains -- see
    // jwt-refresh.strategy.ts.
    if (payload.typ === 'refresh') {
      throw new UnauthorizedException(
        'Refresh token cannot be used for API access',
      );
    }

    // Look the user up on every authenticated request instead of trusting
    // the JWT payload blindly. Without this, disabling a user
    // (POST /users/admin/toggle-status/:userId) has no effect on tokens
    // already issued: the payload's role/email keep being echoed back and
    // the account stays fully usable until the token's natural expiry.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        isDisabled: true,
        tokenVersion: true,
      },
    });

    if (!user || user.isDisabled) {
      throw new UnauthorizedException('Account not found or disabled');
    }

    // A token minted before the user's most recent password change carries
    // a stale (or, for tokens issued before this claim existed, absent —
    // treated as 0 to match the column default and avoid logging out every
    // existing session on deploy) tokenVersion. AuthService bumps the
    // column on every password change, so this is what actually revokes a
    // stolen token the moment the user changes their password, rather than
    // leaving it valid for the rest of its natural lifetime (up to the
    // 30-day refresh token) the way isDisabled alone cannot for an account
    // that was never disabled.
    if ((payload.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException(
        'Session has been invalidated by a password change',
      );
    }

    // CLI tokens are DB-backed so they can be revoked individually, without
    // bumping tokenVersion and logging every browser and phone out too. That
    // only means anything if the revocation is actually checked here.
    if (payload.typ === 'cli') {
      await this.assertCliTokenUsable(payload.cid, user.id);
    }

    const authenticated: AuthenticatedUser = {
      sub: user.id,
      email: user.email,
      role: user.role,
      isDisabled: user.isDisabled,
    };

    // The CLI-only claims are attached only for a CLI token, rather than set to
    // undefined otherwise, so `req.user` for a web request keeps exactly the
    // shape every existing controller and test already expects.
    if (payload.typ === 'cli') {
      authenticated.typ = 'cli';
      authenticated.cid = payload.cid;
      authenticated.scopes = payload.scopes ?? ['full'];
    }

    return authenticated;
  }

  /**
   * Rejects a CLI access token whose CliToken row is missing, revoked, expired,
   * or belongs to a different account.
   *
   * The negative result is deliberately not cached: a token that has just been
   * revoked must stop working now, and caching "this is dead" would only save
   * queries on requests that are already failing.
   */
  private async assertCliTokenUsable(
    cid: string | undefined,
    userId: string,
  ): Promise<void> {
    // A 'cli' token with no cid cannot be checked against anything, so it
    // cannot be revoked either. Refuse it rather than let it through unchecked.
    if (!cid) {
      throw new UnauthorizedException('CLI token is missing its token id');
    }

    const cacheKey = `cli:token:${cid}`;
    const cached = await this.cacheManager.get<boolean>(cacheKey);
    if (cached === true) return;

    const token = await this.prisma.cliToken.findUnique({
      where: { id: cid },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        absoluteExpiresAt: true,
      },
    });

    const now = Date.now();
    const usable =
      token !== null &&
      token.userId === userId &&
      token.revokedAt === null &&
      token.expiresAt.getTime() > now &&
      token.absoluteExpiresAt.getTime() > now;

    if (!usable) {
      throw new UnauthorizedException('CLI token has been revoked or expired');
    }

    await this.cacheManager.set(cacheKey, true, CLI_TOKEN_CACHE_TTL_MS);
  }
}
