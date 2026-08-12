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

  async validate(payload: { sub: string }): Promise<AuthenticatedUser> {
    // Look the user up on every authenticated request instead of trusting
    // the JWT payload blindly. Without this, disabling a user
    // (POST /users/admin/toggle-status/:userId) has no effect on tokens
    // already issued: the payload's role/email keep being echoed back and
    // the account stays fully usable until the token's natural expiry.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, isDisabled: true },
    });

    if (!user || user.isDisabled) {
      throw new UnauthorizedException('Account not found or disabled');
    }

    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      isDisabled: user.isDisabled,
    };
  }
}
