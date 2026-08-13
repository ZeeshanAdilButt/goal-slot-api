import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ConversationGateSecretGuard } from './guards/conversation-gate-secret.guard';
import { InternalMessagingController } from './internal-messaging.controller';
import { JiffyMessagingClient } from './jiffy-messaging.client';
import { MessagingConfigService } from './messaging-config.service';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MessagingTokenService } from './messaging-token.service';

/**
 * Registered unconditionally. Nothing in this module reads configuration
 * at construction time in a way that can fail, so an API deployed without
 * the JIFFY_MESSAGING_* variables still boots — the endpoints just answer
 * 503 until the variables are set. InternalMessagingController is the
 * same story with CONVERSATION_GATE_SECRET: unset means the endpoint
 * rejects every request rather than the API failing to start.
 */
@Module({
  imports: [AuthModule],
  controllers: [MessagingController, InternalMessagingController],
  providers: [
    MessagingConfigService,
    MessagingTokenService,
    JiffyMessagingClient,
    MessagingService,
    ConversationGateSecretGuard,
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
