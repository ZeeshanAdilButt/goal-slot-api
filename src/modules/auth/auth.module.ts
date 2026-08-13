import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  AuthController,
  CHECK_EMAIL_THROTTLE_LIMIT,
  CHECK_EMAIL_THROTTLE_TTL_MS,
} from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { OtpAttemptTrackerService } from './otp-attempt-tracker.service';
import { UsersModule } from '../users/users.module';
import { SubscriptionGuard } from './guards/subscription.guard';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION') || '7d',
        },
      }),
      inject: [ConfigService],
    }),
    CacheModule.register({
      ttl: 300, // 5 minutes in seconds
      max: 1000, // max items in cache
    }),
    // Rate-limits the unauthenticated check-email endpoint so it can't be
    // used to mass-enumerate registered accounts. Kept in its own named
    // throttler bucket, separate from any other module's ThrottlerModule
    // config (see coach-ai for the same pattern).
    ThrottlerModule.forRoot([
      {
        name: 'check-email',
        ttl: CHECK_EMAIL_THROTTLE_TTL_MS,
        limit: CHECK_EMAIL_THROTTLE_LIMIT,
      },
    ]),
    UsersModule,
    PrismaModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    SubscriptionGuard,
    OtpAttemptTrackerService,
  ],
  exports: [AuthService, JwtModule, SubscriptionGuard],
})
export class AuthModule {}
