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
import { TasksModule } from './modules/tasks/tasks.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { HealthModule } from './modules/health/health.module';
import { LabelsModule } from './modules/labels/labels.module';
import { NotesModule } from './modules/notes/notes.module';
import { EmailModule } from './modules/email/email.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { envValidationSchema } from './shared/configuration/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: envValidationSchema,
    }),
    PrismaModule,
    SupabaseModule,
    HealthModule,
    EmailModule,
    AuthModule,
    UsersModule,
    GoalsModule,
    TimeEntriesModule,
    ScheduleModule,
    ReportsModule,
    SharingModule,
    StripeModule,
    TasksModule,
    CategoriesModule,
    LabelsModule,
    NotesModule,
    FeedbackModule,
  ],
})
export class AppModule {}
