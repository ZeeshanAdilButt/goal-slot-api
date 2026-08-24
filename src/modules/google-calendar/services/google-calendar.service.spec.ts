import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../shared/services/encryption.service';
import { ScheduleService } from '../../schedule/schedule.service';
import { GoogleCalendarApiService } from './google-calendar-api.service';
import { GoogleCalendarService } from './google-calendar.service';

/**
 * These cover the two places the flow can go wrong in ways a type checker
 * cannot see: where the OAuth callback sends the browser, and what happens to
 * each event in a partially-failing import.
 */

const ENV: Record<string, string> = {
  FRONTEND_URL: 'https://www.goalslot.io',
  APP_URL: 'https://app.goalslot.io',
  // Deliberately present and multi-valued. An earlier implementation built the
  // post-OAuth redirect out of this variable, which is a comma-separated CORS
  // allow-list, producing URLs like
  // "https://www.goalslot.io,https://goalslot.io/dashboard/settings".
  CORS_ORIGIN: 'https://www.goalslot.io,https://goalslot.io',
};

function build(overrides: {
  env?: Record<string, string>;
  jwtVerify?: () => unknown;
  scheduleCreate?: jest.Mock;
  prisma?: Partial<Record<string, unknown>>;
  exchangeCode?: jest.Mock;
}) {
  const env = overrides.env ?? ENV;

  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;

  const jwt = {
    sign: () => 'signed-state',
    verify:
      overrides.jwtVerify ??
      (() => ({ sub: 'user-1', purpose: 'google_calendar_oauth' })),
  } as unknown as JwtService;

  const prisma = {
    calendarConnection: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        status: 'active',
        accountEmail: 'a@b.com',
        refreshCiphertext: new Uint8Array(),
        refreshIv: new Uint8Array(),
        refreshAuthTag: new Uint8Array(),
      }),
      upsert: jest.fn().mockResolvedValue({ id: 'conn-1' }),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    importedCalendarEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    scheduleBlock: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides.prisma,
  } as unknown as PrismaService;

  const encryption = {
    encrypt: () => ({
      ciphertext: Buffer.from('c'),
      iv: Buffer.from('i'),
      authTag: Buffer.from('a'),
      keyVersion: 1,
    }),
    decrypt: () => 'refresh-token',
  } as unknown as EncryptionService;

  const googleApi = {
    isConfigured: true,
    exchangeCode:
      overrides.exchangeCode ??
      jest.fn().mockResolvedValue({
        email: 'user@gmail.com',
        tokens: { refreshToken: 'r', accessToken: 'a', scopes: [] },
      }),
    buildConsentUrl: jest
      .fn()
      .mockReturnValue('https://accounts.google.com/...'),
    getAccessToken: jest.fn().mockResolvedValue('access-token'),
    listCalendars: jest.fn().mockResolvedValue([]),
    listEvents: jest.fn().mockResolvedValue([]),
    revoke: jest.fn(),
  } as unknown as GoogleCalendarApiService;

  const schedule = {
    create: overrides.scheduleCreate ?? jest.fn(),
  } as unknown as ScheduleService;

  return {
    service: new GoogleCalendarService(
      prisma,
      encryption,
      googleApi,
      schedule,
      jwt,
      config,
    ),
    prisma,
    schedule,
  };
}

describe('GoogleCalendarService.handleCallback', () => {
  it('redirects to a single clean frontend origin on success', async () => {
    const { service } = build({});
    const url = await service.handleCallback('code', 'state');

    expect(url).toBe(
      'https://www.goalslot.io/dashboard/settings?tab=integrations&google_calendar=connected',
    );
    // The specific regression: no comma-joined CORS list smuggled into the host.
    expect(url).not.toContain(',');
    expect(() => new URL(url)).not.toThrow();
  });

  it('falls back to APP_URL when FRONTEND_URL is unset', async () => {
    const { service } = build({
      env: { APP_URL: ENV.APP_URL, CORS_ORIGIN: ENV.CORS_ORIGIN },
    });
    const url = await service.handleCallback('code', 'state');
    expect(url).toBe(
      'https://app.goalslot.io/dashboard/settings?tab=integrations&google_calendar=connected',
    );
  });

  // Every failure has to land the user back on Settings. Throwing would render
  // a JSON error page on the API domain in the middle of an OAuth redirect.
  it.each([
    ['consent denied', { error: 'access_denied' }, 'denied'],
    ['no code', {}, 'missing_code'],
  ])('redirects with reason=%s', async (_label, args, reason) => {
    const { service } = build({});
    const url = await service.handleCallback(
      (args as { code?: string }).code,
      'state',
      (args as { error?: string }).error,
    );
    expect(url).toContain('google_calendar=error');
    expect(url).toContain(`reason=${reason}`);
  });

  it('rejects a state JWT minted for a different purpose', async () => {
    const { service } = build({
      jwtVerify: () => ({ sub: 'user-1', purpose: 'google_oauth' }),
    });
    const url = await service.handleCallback('code', 'state');
    expect(url).toContain('reason=bad_state');
  });

  it('rejects an unverifiable state', async () => {
    const { service } = build({
      jwtVerify: () => {
        throw new Error('invalid signature');
      },
    });
    const url = await service.handleCallback('code', 'state');
    expect(url).toContain('reason=bad_state');
  });

  it('reports a stable reason and never leaks the Google error text', async () => {
    const { service } = build({
      exchangeCode: jest
        .fn()
        .mockRejectedValue(
          new Error('Google said something with secrets in it'),
        ),
    });
    const url = await service.handleCallback('code', 'state');
    expect(url).toContain('reason=exchange_failed');
    expect(url).not.toContain('secrets');
  });
});

describe('GoogleCalendarService.importEvents', () => {
  const event = (id: string, title: string) => ({
    externalEventId: id,
    externalCalId: 'primary',
    title,
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '10:00',
  });

  it('creates a block per selected event through ScheduleService', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'block-1' });
    const { service } = build({ scheduleCreate: create });

    const result = await service.importEvents('user-1', {
      events: [event('e1', 'Standup')],
    });

    expect(result.imported).toBe(1);
    expect(result.results[0]).toMatchObject({
      externalEventId: 'e1',
      status: 'imported',
      scheduleBlockId: 'block-1',
    });
    // Routed through the service, not straight to Prisma, so plan limits and
    // the conflict guard still apply to imported blocks.
    expect(create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Standup',
        dayOfWeek: 1,
        startTime: '09:00',
        endTime: '10:00',
        category: 'MEETING',
      }),
    );
  });

  // One bad event out of many must not discard the rest, and the user has to
  // be told which ones did not land.
  it('reports per-event outcomes instead of failing the whole batch', async () => {
    const create = jest
      .fn()
      .mockResolvedValueOnce({ id: 'block-1' })
      .mockRejectedValueOnce(
        new Error('Time slot conflicts with an existing schedule block'),
      )
      .mockResolvedValueOnce({ id: 'block-3' });

    const { service } = build({ scheduleCreate: create });

    const result = await service.importEvents('user-1', {
      events: [event('e1', 'One'), event('e2', 'Two'), event('e3', 'Three')],
    });

    expect(result.imported).toBe(2);
    expect(result.results.map((r) => r.status)).toEqual([
      'imported',
      'conflict',
      'imported',
    ]);
  });

  it('skips an event already recorded as imported', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'block-1' });
    const { service } = build({
      scheduleCreate: create,
      prisma: {
        importedCalendarEvent: {
          findMany: jest.fn().mockResolvedValue([{ externalEventId: 'e1' }]),
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
      },
    });

    const result = await service.importEvents('user-1', {
      events: [event('e1', 'Standup')],
    });

    expect(result.imported).toBe(0);
    expect(result.results[0].status).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  // The per-request database lookup cannot see a duplicate inside the payload
  // itself, so the in-flight set has to.
  it('skips a duplicate appearing twice in the same payload', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'block-1' });
    const { service } = build({ scheduleCreate: create });

    const result = await service.importEvents('user-1', {
      events: [event('e1', 'Standup'), event('e1', 'Standup')],
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.results.map((r) => r.status)).toEqual([
      'imported',
      'skipped',
    ]);
  });
});
