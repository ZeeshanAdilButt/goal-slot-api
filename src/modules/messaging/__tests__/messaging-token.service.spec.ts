import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { MessagingConfigService } from '../messaging-config.service';
import { MessagingTokenService } from '../messaging-token.service';

const SECRET = 'jiffy-shared-secret';

function buildTokenService(overrides: Record<string, unknown> = {}) {
  const env: Record<string, unknown> = {
    JIFFY_MESSAGING_URL: 'https://messaging.example.com',
    JIFFY_MESSAGING_JWT_SECRET: SECRET,
    ...overrides,
  };

  const config = new MessagingConfigService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

  return new MessagingTokenService(config);
}

// Verifying with a plain JwtService rather than trusting our own encoder:
// these claims are the contract with jiffy-messaging, and the point of the
// test is that they survive the round trip a real deployment does.
const verifier = new JwtService({});

describe('MessagingTokenService', () => {
  it('signs sub with the GoalSlot user id', async () => {
    const minted = await buildTokenService().mint('user_1');

    const payload = verifier.verify(minted.token, {
      secret: SECRET,
      issuer: 'goalslot-api',
      audience: 'jiffy-messaging',
    }) as Record<string, unknown>;

    expect(payload.sub).toBe('user_1');
    expect(payload.iss).toBe('goalslot-api');
    expect(payload.aud).toBe('jiffy-messaging');
  });

  it('honours a configured issuer and audience', async () => {
    const minted = await buildTokenService({
      JIFFY_MESSAGING_JWT_ISSUER: 'goalslot',
      JIFFY_MESSAGING_JWT_AUDIENCE: 'chat',
    }).mint('user_1');

    const payload = verifier.verify(minted.token, {
      secret: SECRET,
      issuer: 'goalslot',
      audience: 'chat',
    }) as Record<string, unknown>;

    expect(payload.sub).toBe('user_1');
  });

  it('is short-lived and reports its own lifetime', async () => {
    const minted = await buildTokenService({
      JIFFY_MESSAGING_TOKEN_TTL: '300',
    }).mint('user_1');

    const payload = verifier.verify(minted.token, { secret: SECRET }) as {
      iat: number;
      exp: number;
    };

    expect(payload.exp - payload.iat).toBe(300);
    expect(minted.expiresIn).toBe(300);
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('cannot be verified with the GoalSlot session secret', async () => {
    const minted = await buildTokenService().mint('user_1');

    expect(() =>
      verifier.verify(minted.token, { secret: 'goalslot-session-secret' }),
    ).toThrow();
  });

  it('refuses to mint when messaging is unconfigured', async () => {
    const config = new MessagingConfigService({
      get: () => undefined,
    } as unknown as ConfigService);

    await expect(new MessagingTokenService(config).mint('user_1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
