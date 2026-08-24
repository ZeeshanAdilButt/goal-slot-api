import { ConfigService } from '@nestjs/config';
import {
  getGoogleOAuthConfig,
  isGoogleOAuthConfigured,
  resolveFrontendUrl,
} from './google-oauth.config';
import { GoogleStrategy } from './strategies/google.strategy';

const configOf = (values: Record<string, string | undefined>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('google-oauth.config', () => {
  describe('getGoogleOAuthConfig', () => {
    it('returns null when nothing is configured', () => {
      expect(getGoogleOAuthConfig(configOf({}))).toBeNull();
    });

    it.each([
      ['only the id', { GOOGLE_CLIENT_ID: 'id' }],
      ['only the secret', { GOOGLE_CLIENT_SECRET: 'secret' }],
      [
        'id and secret but no callback URL',
        { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
      ],
    ])('returns null with %s', (_label, values) => {
      expect(getGoogleOAuthConfig(configOf(values))).toBeNull();
    });

    it('treats blank/whitespace credentials as absent', () => {
      const config = configOf({
        GOOGLE_CLIENT_ID: '   ',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_CALLBACK_URL: 'https://api.goalslot.io/api/auth/google/callback',
      });
      expect(getGoogleOAuthConfig(config)).toBeNull();
    });

    it('returns the full config once all three are present', () => {
      const config = configOf({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_CALLBACK_URL: 'https://api.goalslot.io/api/auth/google/callback',
      });
      expect(getGoogleOAuthConfig(config)).toEqual({
        clientID: 'id',
        clientSecret: 'secret',
        callbackURL: 'https://api.goalslot.io/api/auth/google/callback',
      });
    });

    it('never derives the callback from APP_URL', () => {
      // APP_URL is the web app in this deployment, not the API, so deriving
      // from it would send Google's redirect to a host with no such route.
      const config = configOf({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        APP_URL: 'https://www.goalslot.io',
      });
      expect(getGoogleOAuthConfig(config)).toBeNull();
    });
  });

  describe('isGoogleOAuthConfigured', () => {
    it('is false without credentials and true with them', () => {
      expect(isGoogleOAuthConfigured(configOf({}))).toBe(false);
      expect(
        isGoogleOAuthConfigured(
          configOf({
            GOOGLE_CLIENT_ID: 'id',
            GOOGLE_CLIENT_SECRET: 'secret',
            GOOGLE_CALLBACK_URL:
              'https://api.goalslot.io/api/auth/google/callback',
          }),
        ),
      ).toBe(true);
    });
  });

  describe('resolveFrontendUrl', () => {
    it('prefers FRONTEND_URL, falls back to APP_URL, and strips trailing slashes', () => {
      expect(
        resolveFrontendUrl(
          configOf({
            FRONTEND_URL: 'https://www.goalslot.io/',
            APP_URL: 'https://api.goalslot.io',
          }),
        ),
      ).toBe('https://www.goalslot.io');

      expect(
        resolveFrontendUrl(configOf({ APP_URL: 'https://api.goalslot.io/' })),
      ).toBe('https://api.goalslot.io');
    });
  });

  /**
   * The regression this whole file exists to prevent. The first Google OAuth
   * attempt (#52) constructed the strategy unconditionally from ConfigService,
   * so an environment without GOOGLE_CLIENT_ID crashed the entire API during
   * Nest's bootstrap -- not just Google login -- and had to be reverted.
   */
  describe('bootstrap safety', () => {
    it('constructing the strategy without credentials throws (why the guard exists)', () => {
      expect(
        () =>
          new GoogleStrategy({
            clientID: undefined as unknown as string,
            clientSecret: undefined as unknown as string,
            callbackURL: 'https://api.test/cb',
          }),
      ).toThrow(/clientID/i);
    });

    it('the module factory declines to construct it instead of throwing', () => {
      // Mirrors googleStrategyProvider.useFactory in auth.module.ts.
      const factory = (configService: ConfigService) => {
        const googleConfig = getGoogleOAuthConfig(configService);
        return googleConfig ? new GoogleStrategy(googleConfig) : null;
      };

      expect(factory(configOf({}))).toBeNull();
      expect(
        factory(
          configOf({
            GOOGLE_CLIENT_ID: 'id',
            GOOGLE_CLIENT_SECRET: 'secret',
            GOOGLE_CALLBACK_URL:
              'https://api.goalslot.io/api/auth/google/callback',
          }),
        ),
      ).toBeInstanceOf(GoogleStrategy);
    });
  });
});
