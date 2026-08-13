import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  MessagingConfig,
  readConversationGateSecret,
  readMessagingConfig,
  safeEqual,
} from './messaging.config';

/**
 * Holds the messaging config for the process, and is the single place
 * that decides what "unconfigured" means to a request.
 *
 * The constructor deliberately cannot throw. A provider that throws while
 * Nest is building the container takes the entire API down at boot, and
 * this module reads environment variables that will not exist on the
 * first deploy that contains it. Messaging going dark is survivable; the
 * API failing to start is not.
 */
@Injectable()
export class MessagingConfigService {
  private readonly logger = new Logger(MessagingConfigService.name);
  private readonly config: MessagingConfig | null;
  private readonly gateSecret: string | null;

  constructor(configService: ConfigService) {
    const read = (key: string) => configService.get(key);
    this.config = readMessagingConfig(read);
    this.gateSecret = readConversationGateSecret(read);

    if (!this.config) {
      this.logger.warn(
        'JIFFY_MESSAGING_URL and/or JIFFY_MESSAGING_JWT_SECRET are not set. ' +
          'Messaging is disabled and the /messaging endpoints will answer 503.',
      );
    }

    if (!this.gateSecret) {
      this.logger.warn(
        'CONVERSATION_GATE_SECRET is not set. ' +
          'POST /internal/messaging/can-create-conversation will reject every request.',
      );
    }
  }

  get isEnabled(): boolean {
    return this.config !== null;
  }

  /**
   * The config, or a 503 for callers that need it. 503 rather than 500:
   * nothing is broken, the feature is simply not turned on here, and a
   * client can reasonably retry after the variables are deployed.
   */
  require(): MessagingConfig {
    if (!this.config) {
      throw new ServiceUnavailableException(
        'Messaging is not configured on this server',
      );
    }

    return this.config;
  }

  /**
   * Checks a credential presented to the internal conversation-gate
   * endpoint against CONVERSATION_GATE_SECRET. Fails closed: with no
   * secret configured, or no credential presented, this is always false —
   * there is no "disabled" state for this check the way there is for the
   * rest of the messaging config, because the thing being disabled here
   * is an authorization decision, not a feature.
   */
  verifyGateSecret(provided: string | undefined): boolean {
    if (!this.gateSecret || !provided) return false;
    return safeEqual(provided, this.gateSecret);
  }
}
