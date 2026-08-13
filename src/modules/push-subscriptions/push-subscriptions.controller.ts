import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { RegisterPushSubscriptionDto } from './dto/push-subscriptions.dto';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';

@ApiTags('push-subscriptions')
@Controller('push-subscriptions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PushSubscriptionsController {
  constructor(private pushSubscriptionsService: PushSubscriptionsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Register a web push or Expo push subscription for the current user',
  })
  async register(
    @Request() req: AuthenticatedRequest,
    @Body() dto: RegisterPushSubscriptionDto,
  ) {
    return this.pushSubscriptionsService.register(req.user.sub, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Unregister a push subscription' })
  async unregister(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.pushSubscriptionsService.unregister(id, req.user.sub);
  }
}
