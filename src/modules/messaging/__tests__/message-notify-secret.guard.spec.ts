import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MessageNotifySecretGuard } from '../guards/message-notify-secret.guard';
import { MessagingConfigService } from '../messaging-config.service';

function configService(env: Record<string, unknown>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function contextWithAuthHeader(header?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header !== undefined ? { authorization: header } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

const CONFIGURED = configService({ MESSAGE_NOTIFY_SECRET: 'shared-secret' });

describe('MessageNotifySecretGuard', () => {
  it('rejects every request when MESSAGE_NOTIFY_SECRET is not configured', () => {
    const guard = new MessageNotifySecretGuard(
      new MessagingConfigService(configService({})),
    );

    expect(() =>
      guard.canActivate(contextWithAuthHeader('Bearer anything')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a request with no Authorization header', () => {
    const guard = new MessageNotifySecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(() => guard.canActivate(contextWithAuthHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a non-Bearer scheme even if the value matches', () => {
    const guard = new MessageNotifySecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(() =>
      guard.canActivate(contextWithAuthHeader('Basic shared-secret')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a mismatched secret', () => {
    const guard = new MessageNotifySecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(() =>
      guard.canActivate(contextWithAuthHeader('Bearer wrong-secret')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects the conversation-gate secret — the two credentials are not interchangeable', () => {
    const guard = new MessageNotifySecretGuard(
      new MessagingConfigService(
        configService({
          MESSAGE_NOTIFY_SECRET: 'notify-secret',
          CONVERSATION_GATE_SECRET: 'gate-secret',
        }),
      ),
    );

    expect(() =>
      guard.canActivate(contextWithAuthHeader('Bearer gate-secret')),
    ).toThrow(UnauthorizedException);
  });

  it('allows a request with the exact configured secret', () => {
    const guard = new MessageNotifySecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(
      guard.canActivate(contextWithAuthHeader('Bearer shared-secret')),
    ).toBe(true);
  });
});
