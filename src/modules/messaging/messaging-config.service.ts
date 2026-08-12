import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MessagingConfig, readMessagingConfig } from './messaging.config';

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

  constructor(configService: ConfigService) {
    this.config = readMessagingConfig((key) => configService.get(key));

    if (!this.config) {
      this.logger.warn(
        'JIFFY_MESSAGING_URL and/or JIFFY_MESSAGING_JWT_SECRET are not set. ' +
          'Messaging is disabled and the /messaging endpoints will answer 503.',
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
}
