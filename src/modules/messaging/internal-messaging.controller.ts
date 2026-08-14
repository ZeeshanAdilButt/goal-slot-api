import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import {
  CanCreateConversationDto,
  OnMessageSentDto,
} from './dto/messaging.dto';
import { ConversationGateSecretGuard } from './guards/conversation-gate-secret.guard';
import { MessageNotifySecretGuard } from './guards/message-notify-secret.guard';
import { MessagingService } from './messaging.service';

/**
 * Service-to-service only, both routes. jiffy-messaging calls
 * can-create-conversation to ask whether it may create a conversation, or
 * accept a new message, for a given set of participants — the
 * ConversationGate callback described in jiffy-messaging's README — and
 * on-message-sent after a message is durably written, so this API can
 * dispatch its own push/email notification to the recipients — the
 * MessageNotifier callback.
 *
 * can-create-conversation is the other side of the fix for the
 * authorization bypass where a self-service /messaging/token JWT could be
 * used to call jiffy-messaging's own POST /conversations directly,
 * skipping this API's canMessage check entirely: jiffy-messaging now
 * consults it before creating a conversation and before every send.
 *
 * Each route carries its own guard rather than one at the controller
 * level: the two callbacks are different capabilities with deliberately
 * separate secrets (see ConversationGateSecretGuard and
 * MessageNotifySecretGuard), and a caller with one credential should not
 * automatically be trusted for the other. Neither ever accepts a
 * self-service user token.
 *
 * Excluded from the public Swagger document on purpose: this is not part
 * of the API surface GoalSlot clients or third parties are meant to see
 * or call.
 */
@ApiExcludeController()
@Controller('internal/messaging')
export class InternalMessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post('can-create-conversation')
  @HttpCode(200)
  @UseGuards(ConversationGateSecretGuard)
  async canCreateConversation(@Body() dto: CanCreateConversationDto) {
    const allowed = await this.messagingService.canCreateConversation(
      dto.requesterId,
      dto.participantIds,
    );
    return { allowed };
  }

  @Post('on-message-sent')
  @HttpCode(200)
  @UseGuards(MessageNotifySecretGuard)
  async onMessageSent(@Body() dto: OnMessageSentDto) {
    await this.messagingService.notifyMessageSent(dto);
    return { ok: true };
  }
}
