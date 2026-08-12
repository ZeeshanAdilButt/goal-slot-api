import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MessagingConfigService } from '../messaging-config.service';
import {
  MESSAGING_CONFIG_DEFAULTS,
  readMessagingConfig,
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
