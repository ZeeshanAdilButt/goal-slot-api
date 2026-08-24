import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { GoogleCalendarController } from './google-calendar.controller';
import { GoogleCalendarApiService } from './services/google-calendar-api.service';
import { GoogleCalendarService } from './services/google-calendar.service';

/**
 * Registered unconditionally, and that is safe: nothing in this module reads
 * Google credentials at construction time. `GoogleCalendarApiService` resolves
 * them per request through `getGoogleCalendarConfig` and answers 404 when they
 * are absent, so a deployment with no Google Calendar configuration boots
 * normally and simply has these routes turned off.
 *
 * The distinction matters — a passport strategy could not be registered this
 * way, which is exactly how the first Google sign-in attempt (#52) crashed
 * bootstrap. See google-calendar.config.ts.
 *
 * AuthModule supplies JwtAuthGuard's JwtModule and the JwtService used to sign
 * the OAuth `state`. ScheduleModule supplies ScheduleService, so imports go
 * through the same plan-limit and conflict-guard path as any other block
 * creation. PrismaService and EncryptionService are global.
 */
@Module({
  imports: [AuthModule, ScheduleModule],
  controllers: [GoogleCalendarController],
  providers: [GoogleCalendarApiService, GoogleCalendarService],
})
export class GoogleCalendarModule {}
