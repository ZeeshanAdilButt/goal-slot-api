import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ConversationGateSecretGuard } from '../guards/conversation-gate-secret.guard';
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

const CONFIGURED = configService({ CONVERSATION_GATE_SECRET: 'shared-secret' });

describe('ConversationGateSecretGuard', () => {
  it('rejects every request when CONVERSATION_GATE_SECRET is not configured', () => {
    const guard = new ConversationGateSecretGuard(
      new MessagingConfigService(configService({})),
    );

    expect(() =>
      guard.canActivate(contextWithAuthHeader('Bearer anything')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a request with no Authorization header', () => {
    const guard = new ConversationGateSecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(() => guard.canActivate(contextWithAuthHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a non-Bearer scheme even if the value matches', () => {
    const guard = new ConversationGateSecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(() =>
      guard.canActivate(contextWithAuthHeader('Basic shared-secret')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a mismatched secret', () => {
    const guard = new ConversationGateSecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(() =>
      guard.canActivate(contextWithAuthHeader('Bearer wrong-secret')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a GoalSlot user JWT the same as any other wrong credential', () => {
    // Not a real JWT verification bypass test - just proving there is no
    // special case here for anything that merely looks like a token. Only
    // an exact match against CONVERSATION_GATE_SECRET passes.
    const guard = new ConversationGateSecretGuard(
      new MessagingConfigService(CONFIGURED),
    );
    const looksLikeAJwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature';

    expect(() =>
      guard.canActivate(contextWithAuthHeader(`Bearer ${looksLikeAJwt}`)),
    ).toThrow(UnauthorizedException);
  });

  it('allows a request with the exact configured secret', () => {
    const guard = new ConversationGateSecretGuard(
      new MessagingConfigService(CONFIGURED),
    );

    expect(
      guard.canActivate(contextWithAuthHeader('Bearer shared-secret')),
    ).toBe(true);
  });
});
