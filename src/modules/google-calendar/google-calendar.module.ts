import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GoogleCalendarController } from './google-calendar.controller';
import { CalendarSyncService } from './services/calendar-sync.service';
import { GoogleApiService } from './services/google-api.service';
import { GoogleCalendarService } from './services/google-calendar.service';

// AuthModule provides JwtAuthGuard (via JwtModule) and the JwtService used to
// sign/verify the OAuth `state`. PrismaService + EncryptionService are global.
@Module({
  imports: [AuthModule],
  controllers: [GoogleCalendarController],
  providers: [GoogleApiService, GoogleCalendarService, CalendarSyncService],
  exports: [CalendarSyncService],
})
export class GoogleCalendarModule {}
