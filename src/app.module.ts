import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { GoalsModule } from './modules/goals/goals.module';
import { TimeEntriesModule } from './modules/time-entries/time-entries.module';
import { ActiveTimerModule } from './modules/active-timer/active-timer.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SharingModule } from './modules/sharing/sharing.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { PrismaModule } from './prisma/prisma.module';
import { SupabaseModule } from './supabase/supabase.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CoachAiModule } from './modules/coach-ai/coach-ai.module';
import { CoachByokModule } from './modules/coach-byok/coach-byok.module';
import { CoachCheckinModule } from './modules/coach-checkin/coach-checkin.module';
import { CoachInsightsModule } from './modules/coach-insights/coach-insights.module';
import { CoachJournalModule } from './modules/coach-journal/coach-journal.module';
import { CoachProfileModule } from './modules/coach-profile/coach-profile.module';
import { CoachProposalsModule } from './modules/coach-proposals/coach-proposals.module';
import { CoachReflectionModule } from './modules/coach-reflection/coach-reflection.module';
import { CoachVoiceIntentModule } from './modules/coach-voice-intent/coach-voice-intent.module';
import { HealthModule } from './modules/health/health.module';
import { LabelsModule } from './modules/labels/labels.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { NotesModule } from './modules/notes/notes.module';
import { EmailModule } from './modules/email/email.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReleaseNotesModule } from './modules/release-notes/release-notes.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { envValidationSchema } from './shared/configuration/env.validation';
import { EncryptionModule } from './shared/modules/encryption.module';
import { LlmModule } from './shared/modules/llm.module';
import { PostHogModule } from './shared/modules/posthog.module';
import { IdempotencyModule } from './shared/idempotency/idempotency.module';
import { WhiteboardsModule } from './modules/whiteboards/whiteboards.module';
import { PushSubscriptionsModule } from './modules/push-subscriptions/push-subscriptions.module';
import { InstructionsModule } from './modules/instructions/instructions.module';
import { RemindersModule } from './modules/reminders/reminders.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: envValidationSchema,
    }),
    PostHogModule, // Add PostHog module early so it's available globally
    NestScheduleModule.forRoot(),
    IdempotencyModule,
    EncryptionModule,
    LlmModule,
    PrismaModule,
    SupabaseModule,
    HealthModule,
    EmailModule,
    AuthModule,
    UsersModule,
    GoalsModule,
    TimeEntriesModule,
    ActiveTimerModule,
    ScheduleModule,
    ReportsModule,
    SharingModule,
    StripeModule,
    TasksModule,
    CategoriesModule,
    CoachAiModule,
    CoachByokModule,
    CoachCheckinModule,
    CoachInsightsModule,
    CoachJournalModule,
    CoachProfileModule,
    CoachProposalsModule,
    CoachReflectionModule,
    CoachVoiceIntentModule,
    LabelsModule,
    MessagingModule,
    NotesModule,
    FeedbackModule,
    NotificationsModule,
    ReleaseNotesModule,
    WhiteboardsModule,
    TemplatesModule,
    InstructionsModule,
    PushSubscriptionsModule,
    RemindersModule,
  ],
})
export class AppModule {}
