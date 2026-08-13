import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OpenConversationDto } from './dto/messaging.dto';
import { MessagingService } from './messaging.service';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';

@ApiTags('messaging')
@Controller('messaging')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post('token')
  @ApiOperation({
    summary:
      'Mint a short-lived jiffy-messaging token for the authenticated user',
    description:
      'POST again to refresh; the response carries expiresIn so a client ' +
      'can schedule that. Returns 503 when messaging is not configured.',
  })
  async issueToken(@Request() req: AuthenticatedRequest) {
    return this.messagingService.issueToken(req.user.sub);
  }

  @Post('conversations')
  @ApiOperation({
    summary: 'Open (or reuse) the conversation with another GoalSlot user',
    description:
      'Allowed only between users with an accepted report share in either ' +
      'direction; 403 otherwise. 404 if the user does not exist, 503 when ' +
      'messaging is not configured or the service is unreachable.',
  })
  async openConversation(
    @Request() req: AuthenticatedRequest,
    @Body() dto: OpenConversationDto,
  ) {
    return this.messagingService.openConversation(req.user.sub, dto.userId);
  }
}
