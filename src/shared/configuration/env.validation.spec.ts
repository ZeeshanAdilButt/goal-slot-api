import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { envValidationSchema } from './env.validation';

// A configuration that passes, used as the baseline every case below mutates.
// Kept in sync with .env.example on purpose: if a variable becomes required
// and .env.example does not carry it, one of these tests should be the thing
// that notices.
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '4000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_SECRET: 'secret',
    JWT_EXPIRATION: '7d',
    SUPABASE_URL: 'http://localhost',
    SUPABASE_SERVICE_ROLE_KEY: 'dev-service-role-key',
    RESEND_API_KEY: 're_test_key',
    APP_URL: 'http://localhost:4000',
    ONBOARDING_EMAIL: 'onboarding@example.com',
    NOTIFICATION_EMAIL: 'notifications@example.com',
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_PRICE_ID: 'price_mock',
    STRIPE_PRICE_ID_BASIC: 'price_mock_basic',
    STRIPE_PRICE_ID_PRO: 'price_mock_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_mock',
    CORS_ORIGIN: 'http://localhost:3010',
    POSTHOG_API_KEY: '',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_AI_SHARED_API_KEY: '',
    SHARED_COACH_DAILY_LIMIT: '20',
  };
}

// NestJS ConfigModule validates with allowUnknown, so mirror that rather than
// asserting against stricter rules than the app actually applies.
function validate(env: Record<string, string | undefined>) {
  return envValidationSchema.validate(env, { allowUnknown: true, abortEarly: false });
}

/**
 * Minimal .env reader, enough for the shape .env.example actually uses:
 * KEY=value, optional surrounding quotes, # comments, blank lines.
 * Written out rather than importing dotenv, which is only present here as a
 * transitive dependency of @nestjs/config.
 */
function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

describe('envValidationSchema', () => {
  it('accepts the baseline configuration', () => {
    expect(validate(validEnv()).error).toBeUndefined();
  });

  // The point of .env.example is that copying it to .env gets a contributor a
  // process that starts. It did not: RESEND_API_KEY was missing entirely,
  // APP_URL and POSTHOG_HOST held prose where a URI was validated, and
  // BYOK_ENCRYPTION_KEY was blank against a required rule.
  it('accepts .env.example as shipped', () => {
    const contents = readFileSync(join(__dirname, '../../../.env.example'), 'utf8');

    const { error } = validate(parseEnvFile(contents));

    expect(error?.message).toBeUndefined();
  });

  describe('CORS_ORIGIN', () => {
    // main.ts reads this with getOrThrow. When the schema called it optional,
    // validation passed and bootstrap threw afterwards, so the failure read
    // as a crash instead of naming the missing variable.
    it('is required, so a missing value fails validation rather than bootstrap', () => {
      const env = validEnv();
      delete env.CORS_ORIGIN;

      const { error } = validate(env);

      expect(error).toBeDefined();
      expect(error!.message).toContain('CORS_ORIGIN');
    });

    it('accepts a comma-separated list', () => {
      const env = validEnv();
      env.CORS_ORIGIN = 'https://www.goalslot.io,https://goalslot.io,http://localhost:3010';

      expect(validate(env).error).toBeUndefined();
    });

    it('rejects a list containing something that is not a URI', () => {
      const env = validEnv();
      env.CORS_ORIGIN = 'https://goalslot.io,not a url';

      expect(validate(env).error).toBeDefined();
    });
  });

  describe('Stripe per-tier prices', () => {
    // Missing values used to fall back to the single STRIPE_PRICE_ID, so
    // every tier billed the same and nothing said so.
    it.each(['STRIPE_PRICE_ID_BASIC', 'STRIPE_PRICE_ID_PRO'])('requires %s', (name) => {
      const env = validEnv();
      delete env[name];

      const { error } = validate(env);

      expect(error).toBeDefined();
      expect(error!.message).toContain(name);
    });
  });

  describe('RESEND_API_KEY', () => {
    it('is required', () => {
      const env = validEnv();
      delete env.RESEND_API_KEY;

      const { error } = validate(env);

      expect(error).toBeDefined();
      expect(error!.message).toContain('RESEND_API_KEY');
    });
  });

  describe('URI-shaped variables', () => {
    it.each([
      ['APP_URL', 'backend-app-url'],
      ['POSTHOG_HOST', 'https://us.i.posthog.com or your host'],
    ])('rejects %s when it is prose rather than a URI', (name, value) => {
      const env = validEnv();
      env[name] = value;

      expect(validate(env).error).toBeDefined();
    });
  });

  describe('POSTHOG_API_KEY', () => {
    it('allows an empty value, which means analytics off', () => {
      const env = validEnv();
      env.POSTHOG_API_KEY = '';

      expect(validate(env).error).toBeUndefined();
    });
  });

  describe('BYOK_ENCRYPTION_KEY', () => {
    it('rejects an empty value', () => {
      const env = validEnv();
      env.BYOK_ENCRYPTION_KEY = '';

      expect(validate(env).error).toBeDefined();
    });

    it('rejects a key that does not decode to 32 bytes', () => {
      const env = validEnv();
      env.BYOK_ENCRYPTION_KEY = Buffer.alloc(16, 7).toString('base64');

      expect(validate(env).error).toBeDefined();
    });
  });
});
