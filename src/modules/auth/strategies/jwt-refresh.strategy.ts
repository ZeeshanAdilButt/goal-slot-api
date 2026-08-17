import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../shared/types/authenticated-request.interface';

/**
 * Guards POST /auth/refresh, and nothing else.
 *
 * Runs the same user/isDisabled/tokenVersion checks as JwtStrategy, but
 * accepts only a refresh-typed token. Before this existed the endpoint sat
 * behind the ordinary JwtAuthGuard, which meant an *access* token could be
 * exchanged for a brand-new 30-day pair -- so any stolen token could be
 * renewed indefinitely and never aged out.
 */
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
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
    [claim: string]: unknown;
  }): Promise<AuthenticatedUser> {
    // TRANSITIONAL: `typ === undefined` must stay accepted until
    // 2026-09-16. Refresh tokens minted before this deploy carry no `typ`
    // claim at all; rejecting them here would force-log-out every live web
    // and mobile session as soon as its access token expired and the
    // client's interceptor fired its first refresh. Untyped refresh
    // tokens have a 30-day maximum life, so after that date this can be
    // tightened to `payload.typ !== 'refresh'` with no user impact.
    if (payload.typ !== undefined && payload.typ !== 'refresh') {
      throw new UnauthorizedException(
        'A refresh token is required for this endpoint',
      );
    }

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

    // Same revocation semantics as the access path: a password change
    // bumps User.tokenVersion, which must invalidate the refresh token
    // too, otherwise the stale refresh token could simply mint a fresh
    // access token and undo the revocation.
    if ((payload.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException(
        'Session has been invalidated by a password change',
      );
    }

    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      isDisabled: user.isDisabled,
    };
  }
}
