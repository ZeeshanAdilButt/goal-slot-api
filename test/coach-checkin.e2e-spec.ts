import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as http from 'http';
import { AddressInfo } from 'net';

import { CoachCheckinController } from '../src/modules/coach-checkin/coach-checkin.controller';
import { CoachCheckinService } from '../src/modules/coach-checkin/coach-checkin.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

interface FakeCheckin {
  id: string;
  userId: string;
  date: string;
  mood: number;
  energy: number;
  focus: number;
  blocked: string;
  worked: string;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  store = new Map<string, FakeCheckin>(); // key = userId:date
  private key(u: string, d: string) {
    return `${u}:${d}`;
  }
  dailyCheckin = {
    findUnique: async ({
      where,
    }: {
      where: { userId_date: { userId: string; date: string } };
    }) => this.store.get(this.key(where.userId_date.userId, where.userId_date.date)) ?? null,
    findMany: async ({
      where,
      orderBy: _orderBy,
    }: {
      where: { userId: string; date: { gte: string; lte: string } };
      orderBy?: any;
    }) => {
      const rows = Array.from(this.store.values()).filter(
        (r) =>
          r.userId === where.userId &&
          r.date >= where.date.gte &&
          r.date <= where.date.lte,
      );
      rows.sort((a, b) => (a.date < b.date ? 1 : -1));
      return rows;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId_date: { userId: string; date: string } };
      create: any;
      update: any;
    }) => {
      const k = this.key(where.userId_date.userId, where.userId_date.date);
      const existing = this.store.get(k);
      const now = new Date();
      if (!existing) {
        const row: FakeCheckin = {
          id: 'c_' + Math.random().toString(36).slice(2),
          userId: create.userId,
          date: create.date,
          mood: create.mood,
          energy: create.energy,
          focus: create.focus,
          blocked: create.blocked ?? '',
          worked: create.worked ?? '',
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        this.store.set(k, row);
        return row;
      }
      const merged: FakeCheckin = {
        ...existing,
        ...update,
        updatedAt: new Date(),
      };
      this.store.set(k, merged);
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

const TODAY = new Date().toISOString().slice(0, 10);

describe('CoachCheckinModule (e2e)', () => {
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
      controllers: [CoachCheckinController],
      providers: [
        CoachCheckinService,
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

  it('POST creates a check-in and GET /today returns it', async () => {
    const res = await request(baseUrl, 'POST', '/coach/checkins', {
      userId: USER_A,
      body: {
        date: TODAY,
        mood: 4,
        energy: 3,
        focus: 5,
        blocked: 'meetings',
        worked: 'shipped api',
      },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.mood).toBe(4);

    const today = await request(baseUrl, 'GET', '/coach/checkins/today', {
      userId: USER_A,
    });
    expect(today.status).toBe(200);
    expect(today.body).not.toBeNull();
    expect(today.body.mood).toBe(4);
    expect(today.body.focus).toBe(5);
  });

  it('cross-user isolation: user B GET /today returns null even after A wrote today', async () => {
    const today = await request(baseUrl, 'GET', '/coach/checkins/today', {
      userId: USER_B,
    });
    expect(today.status).toBe(200);
    expect(today.body === null || today.body === '' || today.rawBody === '').toBe(true);
  });

  it('GET / returns user A check-ins only', async () => {
    const list = await request(baseUrl, 'GET', '/coach/checkins', {
      userId: USER_A,
    });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.every((r: any) => r.userId === USER_A)).toBe(true);

    const listB = await request(baseUrl, 'GET', '/coach/checkins', {
      userId: USER_B,
    });
    expect(listB.status).toBe(200);
    expect(listB.body).toEqual([]);
  });

  it('rejects out-of-range mood with 400', async () => {
    const res = await request(baseUrl, 'POST', '/coach/checkins', {
      userId: USER_A,
      body: { date: TODAY, mood: 99, energy: 3, focus: 3 },
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid date format with 400', async () => {
    const res = await request(baseUrl, 'POST', '/coach/checkins', {
      userId: USER_A,
      body: { date: 'not-a-date', mood: 3, energy: 3, focus: 3 },
    });
    expect(res.status).toBe(400);
  });
});
