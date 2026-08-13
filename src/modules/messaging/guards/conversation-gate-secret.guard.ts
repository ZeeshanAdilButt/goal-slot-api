import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { MessagingConfigService } from '../messaging-config.service';

/**
 * Gates POST /internal/messaging/can-create-conversation. This is not a
 * user endpoint — JwtAuthGuard has no idea it exists — it is jiffy-messaging
 * calling back to ask "may requesterId be in a conversation with
 * participantIds", authenticated by a secret shared only between the two
 * services and never handed to a browser or a GoalSlot user.
 *
 * Fails closed: no secret configured, no Authorization header, or a
 * mismatch all reject with 401. There is no 503-and-degrade path here the
 * way the outbound messaging config has one (see MessagingConfigService)
 * — an internal authorization endpoint reachable without its secret is
 * not a smaller version of the feature, it is the vulnerability this
 * endpoint exists to close.
 */
@Injectable()
export class ConversationGateSecretGuard implements CanActivate {
  constructor(private readonly config: MessagingConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.['authorization'];
    const provided = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;

    if (!this.config.verifyGateSecret(provided)) {
      throw new UnauthorizedException('Invalid or missing service credential');
    }

    return true;
  }
}
