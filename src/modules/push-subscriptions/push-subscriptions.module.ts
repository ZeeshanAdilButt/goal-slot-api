import { Module } from '@nestjs/common';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WebPushReminderChannel } from './channels/web-push-channel.provider';

@Module({
  controllers: [PushSubscriptionsController],
  providers: [PushSubscriptionsService, WebPushReminderChannel],
  exports: [PushSubscriptionsService, WebPushReminderChannel],
})
export class PushSubscriptionsModule {}
