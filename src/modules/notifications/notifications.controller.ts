import {
  Controller,
  Get,
  Query,
  UseGuards,
  Request,
  Patch,
  Delete,
  HttpCode,
  Param,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';
import {
  DEFAULT_NOTIFICATION_SCOPE,
  NOTIFICATION_SCOPES,
  NotificationScope,
  isNotificationScope,
} from './notification-scope';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List notifications for the current user' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: NOTIFICATION_SCOPES,
    description:
      "Which slice of notifications to return. 'all' (default) is every type; 'general' excludes MESSAGE_RECEIVED, which the messages icon accounts for instead. Applies to `unreadCount` as well as `items`.",
  })
  async list(
    @Request() req: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('scope') scope?: string,
  ) {
    return this.notificationsService.list({
      userId: req.user.sub,
      cursor,
      limit: parseLimit(limit),
      scope: parseScope(scope),
    });
  }

  /**
   * Declared before `:id/read` so the literal segment is matched first.
   * ('read-all' is not a uuid, so it could not collide with a real id
   * anyway, but ordering makes that independent of id format.)
   */
  @Patch('read-all')
  @ApiOperation({
    summary: 'Mark every unread notification in a scope as read',
  })
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: NOTIFICATION_SCOPES,
    description:
      "Must match the scope the caller is listing, so 'mark all read' clears exactly the feed the user is looking at and nothing they never saw.",
  })
  async markAllRead(
    @Request() req: AuthenticatedRequest,
    @Query('scope') scope?: string,
  ) {
    return this.notificationsService.markAllRead(
      req.user.sub,
      parseScope(scope) ?? DEFAULT_NOTIFICATION_SCOPE,
    );
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markRead(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.notificationsService.markRead(id, req.user.sub);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a notification' })
  async delete(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.notificationsService.delete(id, req.user.sub);
  }
}

/**
 * `?limit=abc` used to reach Prisma as `take: NaN` and 500. NaN is not
 * nullish, so the service's `?? 10` never rescued it and `Math.min`/`Math.max`
 * propagated it straight through. A bad query string is a 400.
 */
function parseLimit(limit?: string): number | undefined {
  if (!limit) {
    return undefined;
  }
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException('limit must be a number');
  }
  return parsed;
}

function parseScope(scope?: string): NotificationScope | undefined {
  if (!scope) {
    return undefined;
  }
  if (!isNotificationScope(scope)) {
    throw new BadRequestException(
      `scope must be one of: ${NOTIFICATION_SCOPES.join(', ')}`,
    );
  }
  return scope;
}
