import { ConfigService } from '@nestjs/config';

/**
 * Google OAuth is optional infrastructure: the API must boot, and every other
 * auth path must keep working, on an environment that has no Google
 * credentials at all (local dev, CI, a fresh VPS).
 *
 * This matters because of how it failed last time. The first attempt (#52)
 * built the strategy unconditionally, reading the client id straight into
 * `super({ clientID: config.get('GOOGLE_CLIENT_ID') })`. passport-google-oauth20
 * throws `TypeError: OAuth2Strategy requires a clientID option` from that
 * constructor when the value is undefined -- and because a Nest provider is
 * constructed during bootstrap, that took the entire API down on start rather
 * than failing only the Google routes. It had to be reverted (f207fea).
 *
 * So the credentials are read in exactly one place, here, and everything that
 * depends on them asks this first:
 *   - AuthModule only instantiates GoogleStrategy when this returns a config,
 *     so an unconfigured deployment simply never constructs it.
 *   - GoogleAuthGuard checks it per request and 404s cleanly, so the routes
 *     stay dormant rather than 500ing on "Unknown authentication strategy".
 */
export interface GoogleOAuthConfig {
  clientID: string;
  clientSecret: string;
  callbackURL: string;
}

/**
 * Returns null -- never throws, never returns a half-populated object -- when
 * Google sign-in is not configured for this environment.
 *
 * The callback URL is derived from APP_URL when GOOGLE_CALLBACK_URL is unset,
 * but the id and secret have no sensible default: without both, there is
 * nothing to configure and this is off.
 */
export function getGoogleOAuthConfig(
  configService: ConfigService,
): GoogleOAuthConfig | null {
  const clientID = configService.get<string>('GOOGLE_CLIENT_ID')?.trim();
  const clientSecret = configService
    .get<string>('GOOGLE_CLIENT_SECRET')
    ?.trim();

  const callbackURL = configService.get<string>('GOOGLE_CALLBACK_URL')?.trim();

  if (!clientID || !clientSecret || !callbackURL) return null;

  return { clientID, clientSecret, callbackURL };
}

export function isGoogleOAuthConfigured(configService: ConfigService): boolean {
  return getGoogleOAuthConfig(configService) !== null;
}

/**
 * Where to send the browser once the callback has minted tokens. FRONTEND_URL
 * is the deployed web app; APP_URL is the fallback so a deployment that only
 * sets one still redirects somewhere real instead of localhost.
 */
export function resolveFrontendUrl(configService: ConfigService): string {
  const frontendUrl =
    configService.get<string>('FRONTEND_URL')?.trim() ||
    configService.get<string>('APP_URL')?.trim() ||
    'http://localhost:3010';
  return frontendUrl.replace(/\/+$/, '');
}
