import { ConfigService } from '@nestjs/config';
import {
  getGoogleCalendarConfig,
  isGoogleCalendarConfigured,
  GOOGLE_CALENDAR_SCOPES,
} from './google-calendar.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const COMPLETE = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_CALENDAR_REDIRECT_URI:
    'https://api.goalslot.io/api/integrations/google-calendar/callback',
};

describe('getGoogleCalendarConfig', () => {
  it('returns the config when all three values are present', () => {
    expect(getGoogleCalendarConfig(configWith(COMPLETE))).toEqual({
      clientID: 'client-id',
      clientSecret: 'client-secret',
      redirectURI: COMPLETE.GOOGLE_CALENDAR_REDIRECT_URI,
    });
  });

  // The whole point of the null return. A deployment missing any of these must
  // boot and answer 404 on the calendar routes, not throw during bootstrap the
  // way the reverted sign-in attempt (#52) did.
  it.each([
    ['no credentials at all', {}],
    [
      'sign-in configured but no calendar redirect URI',
      {
        GOOGLE_CLIENT_ID: COMPLETE.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: COMPLETE.GOOGLE_CLIENT_SECRET,
      },
    ],
    [
      'redirect URI set but no client id',
      {
        GOOGLE_CLIENT_SECRET: COMPLETE.GOOGLE_CLIENT_SECRET,
        GOOGLE_CALENDAR_REDIRECT_URI: COMPLETE.GOOGLE_CALENDAR_REDIRECT_URI,
      },
    ],
  ])('returns null with %s', (_label, values) => {
    expect(getGoogleCalendarConfig(configWith(values))).toBeNull();
  });

  // .env.example ships these blank on purpose, and Joi allows ''. A blank
  // string must read as "off", not as a valid credential that produces a
  // consent URL Google will reject.
  it('treats blank and whitespace-only values as unset', () => {
    expect(
      getGoogleCalendarConfig(
        configWith({ ...COMPLETE, GOOGLE_CALENDAR_REDIRECT_URI: '' }),
      ),
    ).toBeNull();
    expect(
      getGoogleCalendarConfig(
        configWith({ ...COMPLETE, GOOGLE_CLIENT_SECRET: '   ' }),
      ),
    ).toBeNull();
  });

  it('trims surrounding whitespace off values', () => {
    const config = getGoogleCalendarConfig(
      configWith({ ...COMPLETE, GOOGLE_CLIENT_ID: '  client-id  ' }),
    );
    expect(config?.clientID).toBe('client-id');
  });

  it('reports configuration state without throwing', () => {
    expect(isGoogleCalendarConfigured(configWith(COMPLETE))).toBe(true);
    expect(isGoogleCalendarConfigured(configWith({}))).toBe(false);
  });
});

describe('GOOGLE_CALENDAR_SCOPES', () => {
  // Requesting read-write would push the app from Google's "sensitive" tier
  // into "restricted", which requires a third-party security assessment before
  // public verification. Nothing here ever writes to Google.
  it('requests read-only calendar access', () => {
    expect(GOOGLE_CALENDAR_SCOPES).toContain(
      'https://www.googleapis.com/auth/calendar.readonly',
    );
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain(
      'https://www.googleapis.com/auth/calendar',
    );
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain(
      'https://www.googleapis.com/auth/calendar.events',
    );
  });
});
