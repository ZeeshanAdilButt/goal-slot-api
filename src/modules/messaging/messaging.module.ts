import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { JiffyMessagingClient } from './jiffy-messaging.client';
import { MessagingConfigService } from './messaging-config.service';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MessagingTokenService } from './messaging-token.service';

/**
 * Registered unconditionally. Nothing in this module reads configuration
 * at construction time in a way that can fail, so an API deployed without
 * the JIFFY_MESSAGING_* variables still boots — the endpoints just answer
 * 503 until the variables are set.
 */
@Module({
  imports: [AuthModule],
  controllers: [MessagingController],
  providers: [
    MessagingConfigService,
    MessagingTokenService,
    JiffyMessagingClient,
    MessagingService,
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
