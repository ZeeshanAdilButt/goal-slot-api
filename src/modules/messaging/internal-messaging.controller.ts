import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { CanCreateConversationDto } from './dto/messaging.dto';
import { ConversationGateSecretGuard } from './guards/conversation-gate-secret.guard';
import { MessagingService } from './messaging.service';

/**
 * Service-to-service only. jiffy-messaging calls this to ask whether it
 * may create a conversation, or accept a new message, for a given set of
 * participants — the ConversationGate callback described in
 * jiffy-messaging's README. This is the other side of the fix for the
 * authorization bypass where a self-service /messaging/token JWT could be
 * used to call jiffy-messaging's own POST /conversations directly,
 * skipping this API's canMessage check entirely: jiffy-messaging now
 * consults this endpoint before creating a conversation and before every
 * send, and a self-service user token is never accepted here (see
 * ConversationGateSecretGuard) — only the shared service secret is.
 *
 * Excluded from the public Swagger document on purpose: this is not part
 * of the API surface GoalSlot clients or third parties are meant to see
 * or call.
 */
@ApiExcludeController()
@Controller('internal/messaging')
@UseGuards(ConversationGateSecretGuard)
export class InternalMessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post('can-create-conversation')
  @HttpCode(200)
  async canCreateConversation(@Body() dto: CanCreateConversationDto) {
    const allowed = await this.messagingService.canCreateConversation(
      dto.requesterId,
      dto.participantIds,
    );
    return { allowed };
  }
}
