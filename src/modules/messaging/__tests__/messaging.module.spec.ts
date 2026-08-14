import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { ReminderDispatchService } from '../../reminders/reminder-dispatch.service';
import { ConversationGateSecretGuard } from '../guards/conversation-gate-secret.guard';
import { MessageNotifySecretGuard } from '../guards/message-notify-secret.guard';
import { InternalMessagingController } from '../internal-messaging.controller';
import { JiffyMessagingClient } from '../jiffy-messaging.client';
import { MessagingConfigService } from '../messaging-config.service';
import { MessagingController } from '../messaging.controller';
import { MessagingService } from '../messaging.service';
import { MessagingTokenService } from '../messaging-token.service';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.interface';

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
    controllers: [MessagingController, InternalMessagingController],
    providers: [
      MessagingConfigService,
      MessagingTokenService,
      JiffyMessagingClient,
      MessagingService,
      ConversationGateSecretGuard,
      MessageNotifySecretGuard,
      { provide: PrismaService, useValue: {} },
      { provide: ReminderDispatchService, useValue: {} },
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
      controller.issueToken({
        user: { sub: 'user_1' },
      } as AuthenticatedRequest),
    ).rejects.toThrow(ServiceUnavailableException);

    await expect(
      controller.openConversation(
        { user: { sub: 'user_1' } } as AuthenticatedRequest,
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
      .issueToken({ user: { sub: 'user_1' } } as AuthenticatedRequest);

    expect(token.messagingUrl).toBe('https://messaging.example.com');
  });

  it('registers the internal conversation-gate controller regardless of outbound messaging config', async () => {
    const moduleRef = await compileWith({});

    expect(moduleRef.get(InternalMessagingController)).toBeInstanceOf(
      InternalMessagingController,
    );
  });

  it('rejects the internal endpoint via its guard when no gate secret is configured', async () => {
    const moduleRef = await compileWith({});
    const guard = moduleRef.get(ConversationGateSecretGuard);

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: 'Bearer anything' } }),
      }),
    } as any;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('accepts the internal endpoint via its guard once CONVERSATION_GATE_SECRET is set, independent of outbound messaging config', async () => {
    const moduleRef = await compileWith({
      CONVERSATION_GATE_SECRET: 'shared-secret',
    });

    expect(moduleRef.get(MessagingConfigService).isEnabled).toBe(false);

    const guard = moduleRef.get(ConversationGateSecretGuard);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer shared-secret' },
        }),
      }),
    } as any;

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects the on-message-sent endpoint via its guard when no notify secret is configured', async () => {
    const moduleRef = await compileWith({});
    const guard = moduleRef.get(MessageNotifySecretGuard);

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: 'Bearer anything' } }),
      }),
    } as any;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('accepts the on-message-sent endpoint via its guard once MESSAGE_NOTIFY_SECRET is set, independent of outbound messaging config', async () => {
    const moduleRef = await compileWith({
      MESSAGE_NOTIFY_SECRET: 'shared-secret',
    });

    expect(moduleRef.get(MessagingConfigService).isEnabled).toBe(false);

    const guard = moduleRef.get(MessageNotifySecretGuard);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer shared-secret' },
        }),
      }),
    } as any;

    expect(guard.canActivate(context)).toBe(true);
  });
});
