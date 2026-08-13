import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JiffyMessagingClient } from '../jiffy-messaging.client';
import { MessagingConfigService } from '../messaging-config.service';

const ENV = {
  JIFFY_MESSAGING_URL: 'https://messaging.example.com/',
  JIFFY_MESSAGING_JWT_SECRET: 'shared-secret',
};

function buildClient(env: Record<string, unknown> = ENV) {
  const config = new MessagingConfigService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

  return new JiffyMessagingClient(config);
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('JiffyMessagingClient', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('calls the service with the bearer token and a normalised URL', async () => {
    const calls: Array<[string, any]> = [];
    global.fetch = (async (url: string, init: any) => {
      calls.push([url, init]);
      return jsonResponse([]);
    }) as any;

    await buildClient().listConversations('token-abc');

    // Trailing slash from the env value must not survive into the path.
    expect(calls[0][0]).toBe('https://messaging.example.com/conversations');
    expect(calls[0][1].method).toBe('GET');
    expect(calls[0][1].headers.authorization).toBe('Bearer token-abc');
    expect(calls[0][1].signal).toBeDefined();
  });

  it('posts participantIds when creating a conversation', async () => {
    const calls: Array<[string, any]> = [];
    global.fetch = (async (url: string, init: any) => {
      calls.push([url, init]);
      return jsonResponse({ id: 'conv_1', participants: [], createdAt: 'now' });
    }) as any;

    const conversation = await buildClient().createConversation('token-abc', [
      'user_1',
      'user_2',
    ]);

    expect(JSON.parse(calls[0][1].body)).toEqual({
      participantIds: ['user_1', 'user_2'],
    });
    expect(conversation.id).toBe('conv_1');
  });

  it('turns an unreachable service into a 503, not a 500', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    await expect(buildClient().listConversations('token')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('turns an error response into a 503', async () => {
    global.fetch = (async () => jsonResponse({ error: 'boom' }, 500)) as any;

    await expect(buildClient().listConversations('token')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('turns an unreadable body into a 503', async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'not json',
    })) as any;

    await expect(buildClient().listConversations('token')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('does not call out at all when unconfigured', async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return jsonResponse([]);
    }) as any;

    await expect(buildClient({}).listConversations('token')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(called).toBe(false);
  });
});
