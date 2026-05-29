import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as http from 'http';
import { AddressInfo } from 'net';

import { CoachProfileController } from '../src/modules/coach-profile/coach-profile.controller';
import { CoachProfileService } from '../src/modules/coach-profile/coach-profile.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

interface FakeProfileRow {
  id: string;
  userId: string;
  why: string;
  phoneBlockerInstalled: boolean;
  distractingSubsCancelled: boolean;
  websiteBlockerUrls: string;
  sleepTargetHours: number;
  bedtime: string;
  wakeTime: string;
  workEnvironment: string;
  additionalContext: string;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  private store = new Map<string, FakeProfileRow>();
  habitsProfile = {
    findUnique: async ({ where }: { where: { userId: string } }) =>
      this.store.get(where.userId) ?? null,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId: string };
      create: any;
      update: any;
    }) => {
      const existing = this.store.get(where.userId);
      const now = new Date();
      if (!existing) {
        const row: FakeProfileRow = {
          id: 'p_' + Math.random().toString(36).slice(2),
          userId: where.userId,
          why: create.why ?? '',
          phoneBlockerInstalled: create.phoneBlockerInstalled ?? false,
          distractingSubsCancelled: create.distractingSubsCancelled ?? false,
          websiteBlockerUrls: create.websiteBlockerUrls ?? '',
          sleepTargetHours: create.sleepTargetHours ?? 8,
          bedtime: create.bedtime ?? '23:00',
          wakeTime: create.wakeTime ?? '07:00',
          workEnvironment: create.workEnvironment ?? '',
          additionalContext: create.additionalContext ?? '',
          createdAt: now,
          updatedAt: now,
        };
        this.store.set(where.userId, row);
        return row;
      }
      const merged: FakeProfileRow = {
        ...existing,
        ...update,
        updatedAt: new Date(),
      };
      this.store.set(where.userId, merged);
      return merged;
    },
  };
}

interface HttpResp {
  status: number;
  body: any;
  rawBody: string;
}
function request(
  baseUrl: string,
  method: string,
  path: string,
  opts: { body?: any; userId?: string } = {},
): Promise<HttpResp> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    if (opts.userId) headers['Authorization'] = `Bearer ${opts.userId}`;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: any = null;
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              body = raw;
            }
          }
          resolve({ status: res.statusCode || 0, body, rawBody: raw });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('CoachProfileModule (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const fakePrisma = new FakePrisma();
  const USER_A = 'user_A';
  const USER_B = 'user_B';

  beforeAll(async () => {
    const guardStub = {
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest();
        const auth = req.headers?.authorization as string | undefined;
        if (!auth || !auth.startsWith('Bearer ')) return false;
        req.user = { sub: auth.slice('Bearer '.length) };
        return true;
      },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [CoachProfileController],
      providers: [
        CoachProfileService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(guardStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    const server = app.getHttpServer();
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET returns schema defaults when no row exists (no auto-create)', async () => {
    const res = await request(baseUrl, 'GET', '/coach/habits-profile', {
      userId: USER_A,
    });
    expect(res.status).toBe(200);
    expect(res.body.sleepTargetHours).toBe(8);
    expect(res.body.bedtime).toBe('23:00');
    expect(res.body.wakeTime).toBe('07:00');
    expect(res.body.why).toBe('');
    // confirm not persisted
    expect((fakePrisma as any).store?.size ?? 0).toBe(0);
  });

  it('PUT upserts and a subsequent GET returns the saved values', async () => {
    const put = await request(baseUrl, 'PUT', '/coach/habits-profile', {
      userId: USER_A,
      body: {
        why: 'ship the coach',
        sleepTargetHours: 7,
        bedtime: '22:30',
        wakeTime: '06:30',
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.why).toBe('ship the coach');
    expect(put.body.sleepTargetHours).toBe(7);

    const get = await request(baseUrl, 'GET', '/coach/habits-profile', {
      userId: USER_A,
    });
    expect(get.status).toBe(200);
    expect(get.body.why).toBe('ship the coach');
    expect(get.body.bedtime).toBe('22:30');
    expect(get.body.wakeTime).toBe('06:30');
  });

  it('cross-user isolation: user B sees defaults, not user A data', async () => {
    const res = await request(baseUrl, 'GET', '/coach/habits-profile', {
      userId: USER_B,
    });
    expect(res.status).toBe(200);
    expect(res.body.why).toBe('');
    expect(res.body.sleepTargetHours).toBe(8);
  });

  it('rejects invalid bedtime format with 400', async () => {
    const res = await request(baseUrl, 'PUT', '/coach/habits-profile', {
      userId: USER_A,
      body: { bedtime: '25:99' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range sleepTargetHours with 400', async () => {
    const res = await request(baseUrl, 'PUT', '/coach/habits-profile', {
      userId: USER_A,
      body: { sleepTargetHours: 99 },
    });
    expect(res.status).toBe(400);
  });
});
