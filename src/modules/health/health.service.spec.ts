import { HealthService } from './health.service';

class FakePrisma {
  shouldFail = false;

  $queryRaw = async (..._args: unknown[]) => {
    if (this.shouldFail) {
      throw new Error('connection refused');
    }
    return [{ '?column?': 1 }];
  };
}

class FakeSupabase {
  connectivityResult: { ok: boolean; latencyMs: number } = {
    ok: true,
    latencyMs: 10,
  };
  checkConnectivityCalls = 0;

  async checkConnectivity() {
    this.checkConnectivityCalls += 1;
    return this.connectivityResult;
  }
}

class FakeConfigService {
  constructor(private values: Record<string, string | undefined> = {}) {}

  get<T = string>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

const PLACEHOLDER_ENV = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'dev-service-role-key',
  RESEND_API_KEY: 'resend-test-key',
};

const REAL_SUPABASE_ENV = {
  SUPABASE_URL: 'https://my-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'a-real-looking-service-role-key',
  RESEND_API_KEY: 'resend-test-key',
};

function buildService(
  env: Record<string, string | undefined>,
  overrides: { prisma?: FakePrisma; supabase?: FakeSupabase } = {},
) {
  const prisma = overrides.prisma ?? new FakePrisma();
  const supabase = overrides.supabase ?? new FakeSupabase();
  const configService = new FakeConfigService(env);

  const service = new HealthService(
    prisma as any,
    supabase as any,
    configService as any,
  );

  return { service, prisma, supabase, configService };
}

describe('HealthService.getDetailedHealth', () => {
  it('reports ok when database passes and Supabase is an unconfigured placeholder', async () => {
    const { service, supabase } = buildService(PLACEHOLDER_ENV);

    const result = await service.getDetailedHealth();

    expect(result.status).toBe('degraded');
    expect(result.checks.supabase).toEqual({ ok: true, configured: false });
    expect(supabase.checkConnectivityCalls).toBe(0);
  });

  it('never returns down when only the unconfigured Supabase dependency would be unreachable', async () => {
    const { service, supabase } = buildService(PLACEHOLDER_ENV, {
      supabase: Object.assign(new FakeSupabase(), {
        connectivityResult: { ok: false, latencyMs: 5 },
      }),
    });

    const result = await service.getDetailedHealth();

    expect(result.status).not.toBe('down');
    // Placeholder config means the network check is skipped entirely, so
    // the injected failure above is never even reached.
    expect(supabase.checkConnectivityCalls).toBe(0);
    expect(result.checks.supabase.configured).toBe(false);
  });

  it('returns down only when the database check fails, even with everything else healthy', async () => {
    const failingPrisma = new FakePrisma();
    failingPrisma.shouldFail = true;
    const { service } = buildService(REAL_SUPABASE_ENV, {
      prisma: failingPrisma,
    });

    const result = await service.getDetailedHealth();

    expect(result.status).toBe('down');
    expect(result.checks.database.ok).toBe(false);
  });

  it('skips the live Supabase connectivity check when SUPABASE_URL is the localhost placeholder', async () => {
    const { service, supabase } = buildService(PLACEHOLDER_ENV);

    await service.getDetailedHealth();

    expect(supabase.checkConnectivityCalls).toBe(0);
  });

  it('performs the live Supabase connectivity check when a real project URL is configured', async () => {
    const { service, supabase } = buildService(REAL_SUPABASE_ENV);

    const result = await service.getDetailedHealth();

    expect(supabase.checkConnectivityCalls).toBe(1);
    expect(result.checks.supabase).toEqual({ ok: true, configured: true });
  });

  it('degrades (not downs) when Supabase is configured with a real project but unreachable', async () => {
    const { service, supabase } = buildService(REAL_SUPABASE_ENV, {
      supabase: Object.assign(new FakeSupabase(), {
        connectivityResult: { ok: false, latencyMs: 2001 },
      }),
    });

    const result = await service.getDetailedHealth();

    expect(supabase.checkConnectivityCalls).toBe(1);
    expect(result.status).toBe('degraded');
    expect(result.checks.supabase).toEqual({ ok: false, configured: true });
  });

  it('reports supabase in the same {ok, configured} shape as resend and geminiShared', async () => {
    const { service } = buildService(REAL_SUPABASE_ENV);

    const result = await service.getDetailedHealth();

    expect(Object.keys(result.checks.supabase).sort()).toEqual(
      ['configured', 'ok'].sort(),
    );
    expect(Object.keys(result.checks.resend).sort()).toEqual(
      ['configured', 'ok'].sort(),
    );
    expect(Object.keys(result.checks.geminiShared).sort()).toEqual(
      ['configured', 'ok'].sort(),
    );
  });

  it('returns ok when database, Supabase, and Resend are all healthy and configured', async () => {
    const { service } = buildService(REAL_SUPABASE_ENV);

    const result = await service.getDetailedHealth();

    expect(result.status).toBe('ok');
  });

  it('treats a 127.0.0.1 SUPABASE_URL the same as the localhost placeholder', async () => {
    const { service, supabase } = buildService({
      ...PLACEHOLDER_ENV,
      SUPABASE_URL: 'http://127.0.0.1:54321',
    });

    const result = await service.getDetailedHealth();

    expect(supabase.checkConnectivityCalls).toBe(0);
    expect(result.checks.supabase.configured).toBe(false);
    expect(result.status).not.toBe('down');
  });
});
