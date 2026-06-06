import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { calendar_v3, google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

// Full calendar scope is requested up front (per maintainer) so the PR2 push
// half needs no second consent screen; userinfo.email lets us label the
// connection with the Google account address.
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export interface GoogleTokens {
  refreshToken: string;
  accessToken?: string | null;
  scopes: string[];
}

/**
 * Thin wrapper over the Google APIs SDK. Holds no DB state — it only builds
 * OAuth clients and makes Google calls. Connection persistence + the sync
 * engine live in the other services.
 *
 * When OAuth env vars are unset the feature is considered disabled and any
 * entry point throws 503, so the rest of the app keeps booting.
 */
@Injectable()
export class GoogleApiService {
  private readonly logger = new Logger(GoogleApiService.name);

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID') &&
        this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET') &&
        this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI'),
    );
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Google Calendar integration is not configured on this server',
      );
    }
  }

  private newOAuthClient(): OAuth2Client {
    this.assertConfigured();
    return new google.auth.OAuth2(
      this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID'),
      this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET'),
      this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI'),
    );
  }

  // Consent URL. `state` is a short-lived signed JWT carrying the userId so
  // the callback (which arrives without an Authorization header) can recover
  // who is connecting. offline + consent guarantees a refresh token.
  buildConsentUrl(state: string): string {
    return this.newOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: GOOGLE_OAUTH_SCOPES,
      state,
    });
  }

  // Exchange the auth code, then read the account email. Throws if Google
  // withheld a refresh token (happens when the user previously consented and
  // we forgot prompt=consent — guarded above, but defended here too).
  async exchangeCode(code: string): Promise<{ tokens: GoogleTokens; email: string }> {
    const client = this.newOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token');
    }
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    if (!data.email) {
      throw new Error('Could not read Google account email');
    }

    return {
      email: data.email,
      tokens: {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
      },
    };
  }

  // OAuth client seeded with a stored refresh token. The SDK auto-refreshes
  // the access token on demand for subsequent calendar calls.
  clientFromRefreshToken(refreshToken: string): OAuth2Client {
    const client = this.newOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  async listCalendars(client: OAuth2Client): Promise<calendar_v3.Schema$CalendarListEntry[]> {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const calendars: calendar_v3.Schema$CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await calendar.calendarList.list({ pageToken, maxResults: 250 });
      calendars.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return calendars;
  }

  // One page of events. Caller drives pagination + syncToken persistence so
  // it can react to 410 (expired token) by clearing and re-pulling.
  async listEventsPage(
    client: OAuth2Client,
    params: {
      calendarId: string;
      syncToken?: string;
      pageToken?: string;
      timeMin?: string;
      timeMax?: string;
    },
  ): Promise<calendar_v3.Schema$Events> {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const { data } = await calendar.events.list({
      calendarId: params.calendarId,
      singleEvents: true,
      showDeleted: true, // so cancelled instances arrive on incremental syncs
      maxResults: 2500,
      syncToken: params.syncToken,
      pageToken: params.pageToken,
      // timeMin/timeMax only valid on a full sync (no syncToken)
      timeMin: params.syncToken ? undefined : params.timeMin,
      timeMax: params.syncToken ? undefined : params.timeMax,
    });
    return data;
  }

  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.newOAuthClient().revokeToken(refreshToken);
    } catch (err) {
      // Already-revoked / network blips must not block local cleanup.
      this.logger.warn(`Google token revoke failed (ignored): ${errMessage(err)}`);
    }
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Google surfaces a revoked/expired grant as an "invalid_grant" error; we use
// this to flag the connection stale instead of retrying forever.
export function isInvalidGrant(err: unknown): boolean {
  const msg = errMessage(err).toLowerCase();
  return msg.includes('invalid_grant');
}

// 410 Gone on events.list means the syncToken expired — do a bounded full
// re-pull.
export function isGoneError(err: unknown): boolean {
  return (err as { code?: number; status?: number })?.code === 410 ||
    (err as { response?: { status?: number } })?.response?.status === 410;
}
