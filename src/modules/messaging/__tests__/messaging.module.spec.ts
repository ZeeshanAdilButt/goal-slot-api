import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { JiffyMessagingClient } from '../jiffy-messaging.client';
import { MessagingConfigService } from '../messaging-config.service';
import { MessagingController } from '../messaging.controller';
import { MessagingService } from '../messaging.service';
import { MessagingTokenService } from '../messaging-token.service';

/**
 * The bootstrap guarantee, and the reason this module reads its config in
 * a provider rather than in a constructor argument list: with none of the
 * JIFFY_MESSAGING_* variables set, the container must still build. A
 * provider that throws here would take the whole API down on the first
 * deploy that ships this code, before the variables exist in the
 * environment.
 */
async function compileWith(env: Record<string, unknown>) {
  return Test.createTestingModule({
    controllers: [MessagingController],
    providers: [
      MessagingConfigService,
      MessagingTokenService,
      JiffyMessagingClient,
      MessagingService,
      { provide: PrismaService, useValue: {} },
      { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
    ],
  }).compile();
}

describe('MessagingModule wiring', () => {
  it('builds the container with no messaging configuration at all', async () => {
    const moduleRef = await compileWith({});

    expect(moduleRef.get(MessagingConfigService).isEnabled).toBe(false);
    expect(moduleRef.get(MessagingController)).toBeInstanceOf(
      MessagingController,
    );
  });

  it('serves a clean 503 from the controller while unconfigured', async () => {
    const controller = (await compileWith({})).get(MessagingController);

    await expect(
      controller.issueToken({ user: { sub: 'user_1' } }),
    ).rejects.toThrow(ServiceUnavailableException);

    await expect(
      controller.openConversation(
        { user: { sub: 'user_1' } },
        { userId: 'user_2' },
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('turns on once the URL and secret are present', async () => {
    const moduleRef = await compileWith({
      JIFFY_MESSAGING_URL: 'https://messaging.example.com',
      JIFFY_MESSAGING_JWT_SECRET: 'shared-secret',
    });

    expect(moduleRef.get(MessagingConfigService).isEnabled).toBe(true);

    const token = await moduleRef
      .get(MessagingController)
      .issueToken({ user: { sub: 'user_1' } });

    expect(token.messagingUrl).toBe('https://messaging.example.com');
  });
});
