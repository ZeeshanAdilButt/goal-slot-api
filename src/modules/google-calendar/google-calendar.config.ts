import { ConfigService } from '@nestjs/config';

/**
 * Google Calendar import is optional infrastructure. The API must boot, and
 * every other route must keep working, on a deployment that has no Google
 * Calendar credentials at all (local dev, CI, a fresh VPS).
 *
 * This is the same rule that plain Google sign-in learned the hard way. The
 * first sign-in attempt (#52) constructed a passport strategy whose
 * constructor read `GOOGLE_CLIENT_ID` straight out of ConfigService and handed
 * it to passport-google-oauth20, which throws
 * `TypeError: OAuth2Strategy requires a clientID option` on undefined. Because
 * Nest constructs providers during bootstrap, that took the entire API down on
 * start rather than failing only the Google routes, and had to be reverted
 * (f207fea). `src/modules/auth/google-oauth.config.ts` is the corrected shape
 * and this file deliberately mirrors it.
 *
 * Calendar import has no passport strategy to crash on, but the same
 * discipline applies for a different reason: credentials are read in exactly
 * one place, and every entry point asks this first, so an unconfigured
 * deployment answers a clean 404 instead of throwing from somewhere deep in a
 * request.
 */
export interface GoogleCalendarConfig {
  clientID: string;
  clientSecret: string;
  redirectURI: string;
}

/**
 * Deliberately reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — the same
 * OAuth client that already powers "Continue with Google" in production —
 * rather than inventing a second pair of variables.
 *
 * Two credentials for one Google Cloud project is a standing configuration
 * hazard: a deployment can end up with sign-in working and calendar import
 * silently 503ing (or vice versa) with no signal about which pair is missing.
 * One client, two redirect URIs is the supported Google configuration, and it
 * keeps the consent screen a single verified app.
 *
 * `GOOGLE_CALENDAR_REDIRECT_URI` is what is genuinely new: the calendar
 * callback is a different path from the sign-in callback, so Google needs it
 * registered separately. It doubles as the feature's on/off switch — a
 * deployment that has sign-in configured but has not yet added the calendar
 * redirect URI in Google Cloud Console gets the calendar routes turned off
 * rather than half-working.
 *
 * Returns null — never throws, never returns a half-populated object.
 */
export function getGoogleCalendarConfig(
  configService: ConfigService,
): GoogleCalendarConfig | null {
  const clientID = configService.get<string>('GOOGLE_CLIENT_ID')?.trim();
  const clientSecret = configService
    .get<string>('GOOGLE_CLIENT_SECRET')
    ?.trim();
  const redirectURI = configService
    .get<string>('GOOGLE_CALENDAR_REDIRECT_URI')
    ?.trim();

  if (!clientID || !clientSecret || !redirectURI) return null;

  return { clientID, clientSecret, redirectURI };
}

export function isGoogleCalendarConfigured(
  configService: ConfigService,
): boolean {
  return getGoogleCalendarConfig(configService) !== null;
}

/**
 * Read-only on purpose. This feature imports events into GoalSlot and never
 * writes back to Google, so `calendar.readonly` is the whole requirement.
 *
 * The narrower scope is not just hygiene. `.../auth/calendar` (read-write) is
 * a Google "restricted" scope requiring a security assessment before the app
 * can be verified for public use; `calendar.readonly` is merely "sensitive",
 * which is a far shorter verification path. Asking for write access we do not
 * use would buy nothing and cost the launch.
 *
 * `userinfo.email` labels the connection with the Google account address so
 * the Settings card can show which account is attached.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];
