import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as http from 'http';
import { AddressInfo } from 'net';

import { CoachReflectionController } from '../src/modules/coach-reflection/coach-reflection.controller';
import { CoachReflectionService } from '../src/modules/coach-reflection/coach-reflection.service';
import { isoWeekKey } from '../src/modules/coach-reflection/iso-week';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

interface FakeGoal {
  id: string;
  userId: string;
}
interface FakeReflection {
  id: string;
  userId: string;
  goalId: string;
  weekKey: string;
  feel: number;
  worked: string;
  blocked: string;
  nextWeekFocus: string;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  goals: FakeGoal[] = [];
  reflections = new Map<string, FakeReflection>(); // key u:g:w
  private key(u: string, g: string, w: string) {
    return `${u}:${g}:${w}`;
  }
  goal = {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
      const found = this.goals.find(
        (g) => g.id === where.id && g.userId === where.userId,
      );
      return found ?? null;
    },
  };
  goalReflection = {
    findUnique: async ({
      where,
    }: {
      where: {
        userId_goalId_weekKey: {
          userId: string;
          goalId: string;
          weekKey: string;
        };
      };
    }) =>
      this.reflections.get(
        this.key(
          where.userId_goalId_weekKey.userId,
          where.userId_goalId_weekKey.goalId,
          where.userId_goalId_weekKey.weekKey,
        ),
      ) ?? null,
    findMany: async ({
      where,
      orderBy: _o,
      take,
    }: {
      where: { userId: string; goalId: string };
      orderBy?: any;
      take?: number;
    }) => {
      const rows = Array.from(this.reflections.values()).filter(
        (r) => r.userId === where.userId && r.goalId === where.goalId,
      );
      rows.sort((a, b) => (a.weekKey < b.weekKey ? 1 : -1));
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: {
        userId_goalId_weekKey: {
          userId: string;
          goalId: string;
          weekKey: string;
        };
      };
      create: any;
      update: any;
    }) => {
      const k = this.key(
        where.userId_goalId_weekKey.userId,
        where.userId_goalId_weekKey.goalId,
        where.userId_goalId_weekKey.weekKey,
      );
      const existing = this.reflections.get(k);
      const now = new Date();
      if (!existing) {
        const row: FakeReflection = {
          id: 'r_' + Math.random().toString(36).slice(2),
          userId: create.userId,
          goalId: create.goalId,
          weekKey: create.weekKey,
          feel: create.feel,
          worked: create.worked ?? '',
          blocked: create.blocked ?? '',
          nextWeekFocus: create.nextWeekFocus ?? '',
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        this.reflections.set(k, row);
        return row;
      }
      const merged: FakeReflection = {
        ...existing,
        ...update,
        updatedAt: new Date(),
      };
      this.reflections.set(k, merged);
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

describe('CoachReflectionModule (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const fakePrisma = new FakePrisma();
  const USER_A = 'user_A';
  const USER_B = 'user_B';
  const GOAL_A = 'goal_A_id';
  const WEEK = isoWeekKey();

  beforeAll(async () => {
    // seed: a goal owned by user A only
    fakePrisma.goals.push({ id: GOAL_A, userId: USER_A });

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
      controllers: [CoachReflectionController],
      providers: [
        CoachReflectionService,
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

  it('POST creates a reflection and GET returns it', async () => {
    const post = await request(
      baseUrl,
      'POST',
      `/coach/goals/${GOAL_A}/reflections`,
      {
        userId: USER_A,
        body: {
          weekKey: WEEK,
          feel: 4,
          worked: 'good week',
          blocked: 'context switching',
          nextWeekFocus: 'deep work blocks',
        },
      },
    );
    expect([200, 201]).toContain(post.status);
    expect(post.body.feel).toBe(4);
    expect(post.body.weekKey).toBe(WEEK);

    const get = await request(
      baseUrl,
      'GET',
      `/coach/goals/${GOAL_A}/reflections?weekKey=${WEEK}`,
      { userId: USER_A },
    );
    expect(get.status).toBe(200);
    expect(get.body.feel).toBe(4);
  });

  it('GET without weekKey defaults to current ISO week', async () => {
    const get = await request(
      baseUrl,
      'GET',
      `/coach/goals/${GOAL_A}/reflections`,
      { userId: USER_A },
    );
    expect(get.status).toBe(200);
    expect(get.body).not.toBeNull();
    expect(get.body.weekKey).toBe(WEEK);
  });

  it('GET /history returns reflections sorted desc, capped at 12', async () => {
    const hist = await request(
      baseUrl,
      'GET',
      `/coach/goals/${GOAL_A}/reflections/history`,
      { userId: USER_A },
    );
    expect(hist.status).toBe(200);
    expect(Array.isArray(hist.body)).toBe(true);
    expect(hist.body.length).toBeGreaterThanOrEqual(1);
    expect(hist.body.length).toBeLessThanOrEqual(12);
  });

  it('cross-user isolation: user B cannot reflect on user A goal (404)', async () => {
    const res = await request(
      baseUrl,
      'POST',
      `/coach/goals/${GOAL_A}/reflections`,
      {
        userId: USER_B,
        body: { weekKey: WEEK, feel: 3 },
      },
    );
    expect(res.status).toBe(404);

    const getB = await request(
      baseUrl,
      'GET',
      `/coach/goals/${GOAL_A}/reflections`,
      { userId: USER_B },
    );
    expect(getB.status).toBe(404);
  });

  it('rejects invalid weekKey with 400', async () => {
    const res = await request(
      baseUrl,
      'POST',
      `/coach/goals/${GOAL_A}/reflections`,
      {
        userId: USER_A,
        body: { weekKey: '2026/22', feel: 3 },
      },
    );
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range feel with 400', async () => {
    const res = await request(
      baseUrl,
      'POST',
      `/coach/goals/${GOAL_A}/reflections`,
      {
        userId: USER_A,
        body: { weekKey: WEEK, feel: 99 },
      },
    );
    expect(res.status).toBe(400);
  });
});
