import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../shared/types/authenticated-request.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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
    [claim: string]: unknown;
  }): Promise<AuthenticatedUser> {
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

    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      isDisabled: user.isDisabled,
    };
  }
}
