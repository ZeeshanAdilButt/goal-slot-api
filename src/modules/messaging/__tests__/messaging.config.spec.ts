import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MessagingConfigService } from '../messaging-config.service';
import {
  MESSAGING_CONFIG_DEFAULTS,
  readConversationGateSecret,
  readMessagingConfig,
  safeEqual,
} from '../messaging.config';

function reader(env: Record<string, unknown>) {
  return (key: string) => env[key];
}

function configService(env: Record<string, unknown>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const MINIMAL = {
  JIFFY_MESSAGING_URL: 'https://messaging.example.com',
  JIFFY_MESSAGING_JWT_SECRET: 'shared-secret',
};

describe('readMessagingConfig', () => {
  it('returns null when nothing is set', () => {
    expect(readMessagingConfig(reader({}))).toBeNull();
  });

  it.each([
    ['url only', { JIFFY_MESSAGING_URL: 'https://messaging.example.com' }],
    ['secret only', { JIFFY_MESSAGING_JWT_SECRET: 'shared-secret' }],
    ['blank values', { ...MINIMAL, JIFFY_MESSAGING_JWT_SECRET: '   ' }],
  ])('returns null with %s', (_label, env) => {
    expect(readMessagingConfig(reader(env))).toBeNull();
  });

  it('applies defaults for the optional variables', () => {
    const config = readMessagingConfig(reader(MINIMAL));

    expect(config).toEqual({
      baseUrl: 'https://messaging.example.com',
      jwtSecret: 'shared-secret',
      issuer: MESSAGING_CONFIG_DEFAULTS.issuer,
      audience: MESSAGING_CONFIG_DEFAULTS.audience,
      tokenTtlSeconds: MESSAGING_CONFIG_DEFAULTS.tokenTtlSeconds,
      requestTimeoutMs: MESSAGING_CONFIG_DEFAULTS.requestTimeoutMs,
    });
  });

  it('strips trailing slashes so path joining stays predictable', () => {
    const config = readMessagingConfig(
      reader({ ...MINIMAL, JIFFY_MESSAGING_URL: 'https://m.example.com///' }),
    );

    expect(config?.baseUrl).toBe('https://m.example.com');
  });

  it('takes overrides for issuer, audience and timings', () => {
    const config = readMessagingConfig(
      reader({
        ...MINIMAL,
        JIFFY_MESSAGING_JWT_ISSUER: 'goalslot',
        JIFFY_MESSAGING_JWT_AUDIENCE: 'chat',
        JIFFY_MESSAGING_TOKEN_TTL: '60',
        JIFFY_MESSAGING_TIMEOUT_MS: '1500',
      }),
    );

    expect(config).toMatchObject({
      issuer: 'goalslot',
      audience: 'chat',
      tokenTtlSeconds: 60,
      requestTimeoutMs: 1500,
    });
  });

  it.each([['nonsense'], ['0'], ['-5'], ['1.5'], ['']])(
    'falls back to the default TTL instead of throwing on %p',
    (raw) => {
      const config = readMessagingConfig(
        reader({ ...MINIMAL, JIFFY_MESSAGING_TOKEN_TTL: raw }),
      );

      expect(config?.tokenTtlSeconds).toBe(
        MESSAGING_CONFIG_DEFAULTS.tokenTtlSeconds,
      );
    },
  );

  it('survives a value Joi coerced to a number', () => {
    const config = readMessagingConfig(
      reader({ ...MINIMAL, JIFFY_MESSAGING_TOKEN_TTL: 120 }),
    );

    expect(config?.tokenTtlSeconds).toBe(120);
  });
});

describe('MessagingConfigService', () => {
  // The bootstrap guarantee: a provider that throws here takes the whole
  // API down on the first deploy that ships this module.
  it('constructs without throwing when nothing is configured', () => {
    expect(() => new MessagingConfigService(configService({}))).not.toThrow();
    expect(new MessagingConfigService(configService({})).isEnabled).toBe(false);
  });

  it('answers 503 rather than 500 when asked for missing config', () => {
    const service = new MessagingConfigService(configService({}));

    expect(() => service.require()).toThrow(ServiceUnavailableException);
    expect(() => service.require()).toThrow(/not configured/i);
  });

  it('is enabled once the URL and secret are present', () => {
    const service = new MessagingConfigService(configService(MINIMAL));

    expect(service.isEnabled).toBe(true);
    expect(service.require().baseUrl).toBe('https://messaging.example.com');
  });
});

describe('readConversationGateSecret', () => {
  it('returns null when unset', () => {
    expect(readConversationGateSecret(reader({}))).toBeNull();
  });

  it('returns null for a blank value', () => {
    expect(
      readConversationGateSecret(reader({ CONVERSATION_GATE_SECRET: '   ' })),
    ).toBeNull();
  });

  it('returns the trimmed secret when set', () => {
    expect(
      readConversationGateSecret(
        reader({ CONVERSATION_GATE_SECRET: '  shared-secret  ' }),
      ),
    ).toBe('shared-secret');
  });
});

describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('shared-secret', 'shared-secret')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(safeEqual('shared-secreu', 'shared-secret')).toBe(false);
  });

  it('returns false for strings of different lengths without throwing', () => {
    expect(() =>
      safeEqual('short', 'a-much-longer-secret-value'),
    ).not.toThrow();
    expect(safeEqual('short', 'a-much-longer-secret-value')).toBe(false);
  });

  it('returns false against an empty string', () => {
    expect(safeEqual('', 'shared-secret')).toBe(false);
  });
});

describe('MessagingConfigService.verifyGateSecret', () => {
  it('rejects every credential when CONVERSATION_GATE_SECRET is unset', () => {
    const service = new MessagingConfigService(configService({}));

    expect(service.verifyGateSecret('anything')).toBe(false);
    expect(service.verifyGateSecret(undefined)).toBe(false);
  });

  it('rejects an undefined credential even when a secret is configured', () => {
    const service = new MessagingConfigService(
      configService({ CONVERSATION_GATE_SECRET: 'shared-secret' }),
    );

    expect(service.verifyGateSecret(undefined)).toBe(false);
  });

  it('rejects a mismatched credential', () => {
    const service = new MessagingConfigService(
      configService({ CONVERSATION_GATE_SECRET: 'shared-secret' }),
    );

    expect(service.verifyGateSecret('wrong-secret')).toBe(false);
  });

  it('accepts the exact configured credential', () => {
    const service = new MessagingConfigService(
      configService({ CONVERSATION_GATE_SECRET: 'shared-secret' }),
    );

    expect(service.verifyGateSecret('shared-secret')).toBe(true);
  });

  it('is independent of the outbound JIFFY_MESSAGING_* configuration', () => {
    const service = new MessagingConfigService(
      configService({ CONVERSATION_GATE_SECRET: 'shared-secret' }),
    );

    // Outbound messaging is off, but the inbound gate secret still works.
    expect(service.isEnabled).toBe(false);
    expect(service.verifyGateSecret('shared-secret')).toBe(true);
  });
});
