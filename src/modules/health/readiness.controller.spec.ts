import { HttpStatus, Logger } from '@nestjs/common';

import { ReadinessController } from './readiness.controller';
import { HealthService } from './health.service';

class FakeResponse {
  statusCode: number | null = null;

  status(code: number) {
    this.statusCode = code;
    return this;
  }
}

/**
 * The real HealthService with fakes underneath, so checkDatabase's timeout
 * race and latency measurement are the ones actually exercised.
 */
function build(queryRaw: () => Promise<unknown>) {
  const prisma = { $queryRaw: queryRaw } as any;
  const supabase = { checkConnectivity: async () => ({ ok: true, latencyMs: 1 }) } as any;
  const config = { get: () => undefined } as any;

  const service = new HealthService(prisma, supabase, config);
  return { controller: new ReadinessController(service), service };
}

describe('ReadinessController', () => {
  beforeAll(() => {
    // The failure path logs at error and warn level on purpose. Silence both
    // so a passing run does not look like a broken one.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('returns 200 when the database answers', async () => {
    const { controller } = build(async () => [{ '?column?': 1 }]);
    const res = new FakeResponse();

    const body = await controller.ready(res as any);

    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(body.status).toBe('ready');
    expect(body.database).toBe('ok');
  });

  it('runs a real query rather than reporting ready unconditionally', async () => {
    let queries = 0;
    const { controller } = build(async () => {
      queries += 1;
      return [];
    });

    await controller.ready(new FakeResponse() as any);

    expect(queries).toBe(1);
  });

  // The whole point of the endpoint: a deploy probe must go red when the
  // process is up but cannot reach its database.
  it('returns 503 when the database is unreachable', async () => {
    const { controller } = build(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    });
    const res = new FakeResponse();

    const body = await controller.ready(res as any);

    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.status).toBe('not ready');
    expect(body.database).toBe('unreachable');
  });

  it('does not leak the driver error message to the caller', async () => {
    const { controller } = build(async () => {
      throw new Error('password authentication failed for user "prod_admin"');
    });

    const body = await controller.ready(new FakeResponse() as any);

    expect(JSON.stringify(body)).not.toContain('prod_admin');
  });

  // getDetailedHealth caches for ten seconds. If readiness went through it, a
  // probe could pass on a result gathered before the restart it is verifying.
  it('does not serve a cached result', async () => {
    let queries = 0;
    let healthy = true;
    const { controller, service } = build(async () => {
      queries += 1;
      if (!healthy) throw new Error('down');
      return [];
    });

    // Warm the detailed-health cache while the database is up.
    await service.getDetailedHealth();
    const queriesAfterWarmup = queries;

    healthy = false;
    const res = new FakeResponse();
    await controller.ready(res as any);

    expect(queries).toBeGreaterThan(queriesAfterWarmup);
    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
