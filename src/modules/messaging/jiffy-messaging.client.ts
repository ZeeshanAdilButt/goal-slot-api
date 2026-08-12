import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { MessagingConfigService } from './messaging-config.service';

export interface JiffyParticipant {
  userId: string;
  lastReadAt: string | null;
}

export interface JiffyConversation {
  id: string;
  participants: JiffyParticipant[];
  createdAt: string;
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Server-to-server calls into jiffy-messaging's REST API.
 *
 * There is no service-level credential to hold: jiffy-messaging
 * authorizes against the conversation's participants, so we call it with
 * a token minted for the acting GoalSlot user. That also means the
 * service enforces participation for us — this client cannot reach a
 * conversation the acting user is not in even if we asked it to.
 *
 * Every failure below collapses to a 503. The distinction between "the
 * host is down", "the request timed out" and "it answered 500" matters in
 * the log, not to the client, and none of them mean the caller did
 * anything wrong.
 */
@Injectable()
export class JiffyMessagingClient {
  private readonly logger = new Logger(JiffyMessagingClient.name);

  constructor(private readonly config: MessagingConfigService) {}

  async listConversations(token: string): Promise<JiffyConversation[]> {
    return this.request<JiffyConversation[]>('GET', '/conversations', token);
  }

  async createConversation(
    token: string,
    participantIds: string[],
  ): Promise<JiffyConversation> {
    return this.request<JiffyConversation>('POST', '/conversations', token, {
      participantIds,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    const config = this.config.require();
    const url = `${config.baseUrl}${path}`;

    let response: FetchResponse;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      this.logger.error(
        `${method} ${path} could not reach the messaging service: ${describe(error)}`,
      );
      throw new ServiceUnavailableException(
        'The messaging service is unreachable',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(
        `${method} ${path} returned ${response.status}: ${detail.slice(0, 300)}`,
      );
      throw new ServiceUnavailableException(
        `The messaging service rejected the request (${response.status})`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error(
        `${method} ${path} returned a body that is not JSON: ${describe(error)}`,
      );
      throw new ServiceUnavailableException(
        'The messaging service returned an unreadable response',
      );
    }
  }
}
