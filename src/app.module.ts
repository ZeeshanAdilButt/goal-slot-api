import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { GoalsModule } from './modules/goals/goals.module';
import { TimeEntriesModule } from './modules/time-entries/time-entries.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SharingModule } from './modules/sharing/sharing.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { PrismaModule } from './prisma/prisma.module';
import { SupabaseModule } from './supabase/supabase.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    SupabaseModule,
    AuthModule,
    UsersModule,
    GoalsModule,
    TimeEntriesModule,
    ScheduleModule,
    ReportsModule,
    SharingModule,
    StripeModule,
  ],
})
export class AppModule {}
