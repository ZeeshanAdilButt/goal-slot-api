import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth.module';
import { PrismaModule } from '../../../prisma/prisma.module';
import {
  CLI_SESSION_THROTTLE_LIMIT,
  CLI_SESSION_THROTTLE_TTL_MS,
  CLI_TOKEN_THROTTLE_LIMIT,
  CLI_TOKEN_THROTTLE_TTL_MS,
  CliAuthController,
} from './cli-auth.controller';
import { CliAuthService } from './cli-auth.service';

/**
 * CLI authentication.
 *
 * Registered in app.module.ts rather than imported by AuthModule: this module
 * imports AuthModule (for JwtModule and OtpAttemptTrackerService), so having
 * AuthModule import it back would be a cycle for no gain. The pieces of the CLI
 * flow that existing auth code needs - the `typ: 'cli'` / `cid` checks in
 * JwtStrategy, and CLI token revocation on password change in AuthService -
 * both go straight to Prisma instead of depending on this module.
 *
 * ThrottlerModule is registered here rather than globally, matching
 * coach-ai.module.ts and auth.module.ts: buckets stay scoped to the module that
 * defines them so one module's limits cannot silently cap another's routes.
 */
@Module({
  imports: [
    AuthModule,
    PrismaModule,
    ThrottlerModule.forRoot([
      {
        name: 'cli-session',
        ttl: CLI_SESSION_THROTTLE_TTL_MS,
        limit: CLI_SESSION_THROTTLE_LIMIT,
      },
      {
        name: 'cli-token',
        ttl: CLI_TOKEN_THROTTLE_TTL_MS,
        limit: CLI_TOKEN_THROTTLE_LIMIT,
      },
    ]),
  ],
  controllers: [CliAuthController],
  providers: [CliAuthService],
  exports: [CliAuthService],
})
export class CliAuthModule {}
