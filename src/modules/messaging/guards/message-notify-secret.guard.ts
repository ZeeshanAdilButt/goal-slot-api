import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { MessagingConfigService } from '../messaging-config.service';

/**
 * Gates POST /internal/messaging/on-message-sent. Not a user endpoint —
 * jiffy-messaging calls back here after a message is sent, so this API
 * can dispatch its own push/email notification to the recipients,
 * authenticated by a secret shared only between the two services.
 *
 * A deliberately separate credential from ConversationGateSecretGuard's:
 * this endpoint and the conversation gate are different capabilities, and
 * a caller with one should not automatically have the other.
 *
 * Fails closed, same reasoning as ConversationGateSecretGuard: no secret
 * configured, no Authorization header, or a mismatch all reject with 401.
 */
@Injectable()
export class MessageNotifySecretGuard implements CanActivate {
  constructor(private readonly config: MessagingConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.['authorization'];
    const provided = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;

    if (!this.config.verifyNotifySecret(provided)) {
      throw new UnauthorizedException('Invalid or missing service credential');
    }

    return true;
  }
}
