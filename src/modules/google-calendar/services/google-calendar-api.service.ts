import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getGoogleCalendarConfig,
  GOOGLE_CALENDAR_SCOPES,
  GoogleCalendarConfig,
} from '../google-calendar.config';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/** Google refuses `maxResults` above 2500 on events.list. */
const EVENTS_PAGE_SIZE = 2500;

/**
 * Hard ceiling on pages walked for one calendar in one preview. A review
 * screen the user has to scroll through is useless past a few hundred rows, and
 * an unbounded `do/while` over `nextPageToken` is how a single busy shared
 * calendar turns one HTTP request into thousands.
 */
const MAX_EVENT_PAGES = 4;

export interface GoogleTokens {
  refreshToken: string;
  accessToken: string;
  scopes: string[];
}

export interface GoogleCalendarListEntry {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
  accessRole: string;
}

export interface GoogleEvent {
  id: string;
  summary?: string;
  status?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

/**
 * Raised when Google says the stored grant is dead (user revoked access in
 * their Google account, or changed their password). The connection is marked
 * `stale` rather than retried — there is nothing to retry, the user has to
 * reconnect.
 */
export class GoogleGrantRevokedError extends Error {
  constructor(message = 'Google access was revoked') {
    super(message);
    this.name = 'GoogleGrantRevokedError';
  }
}

/**
 * Thin wrapper over Google's OAuth and Calendar REST endpoints.
 *
 * Written against `fetch` rather than the `googleapis` package on purpose.
 * This feature needs six calls — token exchange, refresh, revoke, userinfo,
 * calendarList.list, events.list — all of them plain documented REST. The
 * `googleapis` package is a ~13k-line-lockfile generated bundle of every
 * Google API, and a dependency that large is a real cost to audit, install on
 * the VPS, and keep patched, for six URLs.
 *
 * Holds no database state: it builds requests and parses responses. Everything
 * about connections, encryption and importing lives in GoogleCalendarService.
 */
@Injectable()
export class GoogleCalendarApiService {
  private readonly logger = new Logger(GoogleCalendarApiService.name);

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return getGoogleCalendarConfig(this.config) !== null;
  }

  /**
   * A 404 rather than a 503. The routes are not broken, they are turned off on
   * this deployment — the same answer `GoogleAuthGuard` gives for sign-in when
   * its credentials are absent, so both Google features behave alike.
   */
  private requireConfig(): GoogleCalendarConfig {
    const config = getGoogleCalendarConfig(this.config);
    if (!config) {
      throw new NotFoundException(
        'Google Calendar import is not configured on this server',
      );
    }
    return config;
  }

  /**
   * `access_type=offline` plus `prompt=consent` is what actually guarantees a
   * refresh token. Google issues one only on the first consent for a given
   * client/user pair; on every later authorization it returns an access token
   * alone unless consent is forced. Without this, reconnecting after a
   * disconnect would silently produce a connection with no way to refresh.
   */
  buildConsentUrl(state: string): string {
    const config = this.requireConfig();
    const params = new URLSearchParams({
      client_id: config.clientID,
      redirect_uri: config.redirectURI,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
  ): Promise<{ tokens: GoogleTokens; email: string }> {
    const config = this.requireConfig();

    const payload = await this.postForm(TOKEN_ENDPOINT, {
      code,
      client_id: config.clientID,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectURI,
      grant_type: 'authorization_code',
    });

    const refreshToken = payload.refresh_token as string | undefined;
    const accessToken = payload.access_token as string | undefined;
    if (!refreshToken || !accessToken) {
      throw new Error('Google did not return a refresh token');
    }

    const email = await this.fetchAccountEmail(accessToken);

    return {
      email,
      tokens: {
        refreshToken,
        accessToken,
        scopes: String(payload.scope ?? '')
          .split(' ')
          .filter(Boolean),
      },
    };
  }

  /**
   * Access tokens last an hour, and nothing here is long-lived enough to be
   * worth caching them, so every request path starts by trading the stored
   * refresh token for a fresh one.
   */
  async getAccessToken(refreshToken: string): Promise<string> {
    const config = this.requireConfig();
    const payload = await this.postForm(TOKEN_ENDPOINT, {
      client_id: config.clientID,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const accessToken = payload.access_token as string | undefined;
    if (!accessToken) {
      throw new GoogleGrantRevokedError('Google returned no access token');
    }
    return accessToken;
  }

  private async fetchAccountEmail(accessToken: string): Promise<string> {
    const data = await this.getJson(USERINFO_ENDPOINT, accessToken);
    const email = (data as { email?: string }).email;
    if (!email) throw new Error('Could not read Google account email');
    return email;
  }

  /**
   * Only calendars the user can actually read are useful here, and `reader`
   * covers everything from an owned calendar down to a subscribed public one.
   * `freeBusyReader` is filtered out: Google returns those entries with no
   * event titles at all, so they would render as a list of "(No title)" rows
   * the user has no way to review.
   */
  async listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
    const entries: GoogleCalendarListEntry[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ maxResults: '250' });
      if (pageToken) params.set('pageToken', pageToken);

      const data = (await this.getJson(
        `${CALENDAR_BASE}/users/me/calendarList?${params.toString()}`,
        accessToken,
      )) as {
        items?: Array<Record<string, unknown>>;
        nextPageToken?: string;
      };

      for (const item of data.items ?? []) {
        const id = item.id as string | undefined;
        const accessRole = (item.accessRole as string) ?? 'reader';
        if (!id || accessRole === 'freeBusyReader') continue;
        entries.push({
          id,
          name:
            (item.summaryOverride as string) ?? (item.summary as string) ?? id,
          color: (item.backgroundColor as string) ?? null,
          primary: Boolean(item.primary),
          accessRole,
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return entries;
  }

  /**
   * `singleEvents=true` expands recurring events into concrete instances,
   * which is what the review screen needs: a user picking "Standup" wants to
   * see the 09:00 Monday slot it will become, not an RRULE they have to
   * interpret.
   *
   * Cancelled instances are dropped here rather than filtered downstream —
   * this is a one-shot read for a review list, not an incremental sync, so a
   * tombstone has nothing to tombstone.
   */
  async listEvents(
    accessToken: string,
    params: { calendarId: string; timeMin: string; timeMax: string },
  ): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const query = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(EVENTS_PAGE_SIZE),
        timeMin: params.timeMin,
        timeMax: params.timeMax,
      });
      if (pageToken) query.set('pageToken', pageToken);

      const data = (await this.getJson(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(
          params.calendarId,
        )}/events?${query.toString()}`,
        accessToken,
      )) as { items?: GoogleEvent[]; nextPageToken?: string };

      for (const event of data.items ?? []) {
        if (!event.id || event.status === 'cancelled') continue;
        events.push(event);
      }

      pageToken = data.nextPageToken;
      pages += 1;
    } while (pageToken && pages < MAX_EVENT_PAGES);

    return events;
  }

  /**
   * Best effort. An already-revoked token, a network blip, or Google being
   * briefly unhappy must never block the local disconnect — leaving a user
   * unable to detach their account because Google timed out would be the worse
   * failure.
   */
  async revoke(refreshToken: string): Promise<void> {
    try {
      const response = await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
      if (!response.ok) {
        this.logger.warn(
          `Google token revoke returned ${response.status} (ignored)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Google token revoke failed (ignored): ${errMessage(err)}`,
      );
    }
  }

  // --- transport ---

  private async postForm(
    url: string,
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    const text = await response.text();
    if (!response.ok) {
      // `invalid_grant` is Google's answer for a refresh token the user has
      // revoked or that expired after six months of disuse. It is terminal,
      // so it gets its own error type and the caller marks the connection
      // stale instead of logging a generic failure every five minutes.
      if (text.includes('invalid_grant')) {
        throw new GoogleGrantRevokedError();
      }
      throw new Error(
        `Google token request failed (${response.status}): ${truncate(text)}`,
      );
    }

    return JSON.parse(text) as Record<string, unknown>;
  }

  private async getJson(url: string, accessToken: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401) {
        throw new GoogleGrantRevokedError('Google rejected the access token');
      }
      throw new Error(
        `Google API request failed (${response.status}): ${truncate(text)}`,
      );
    }

    return response.json();
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Google error bodies can be long HTML pages. Logs get the first line of the
 * useful part and nothing else — and never the token that was sent.
 */
function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
