import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PushSubscriptionsModule } from '../push-subscriptions/push-subscriptions.module';
import { WebPushReminderChannel } from '../push-subscriptions/channels/web-push-channel.provider';
import { ReminderDispatchService } from './reminder-dispatch.service';
import { ReminderCronService } from './reminder-cron.service';
import { REMINDER_CHANNELS } from './reminder-channel.interface';
import { EmailReminderChannel } from './channels/email-channel.provider';
import { ExpoPushReminderChannel } from './channels/expo-push-channel.provider';

@Module({
  imports: [PrismaModule, PushSubscriptionsModule],
  providers: [
    ReminderDispatchService,
    ReminderCronService,
    EmailReminderChannel,
    ExpoPushReminderChannel,
    {
      provide: REMINDER_CHANNELS,
      useFactory: (email: EmailReminderChannel, expoPush: ExpoPushReminderChannel, webPush: WebPushReminderChannel) => [
        email,
        expoPush,
        webPush,
      ],
      inject: [EmailReminderChannel, ExpoPushReminderChannel, WebPushReminderChannel],
    },
  ],
  exports: [ReminderDispatchService],
})
export class RemindersModule {}
