import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as http from 'http';
import { AddressInfo } from 'net';

import { CoachJournalController } from '../src/modules/coach-journal/coach-journal.controller';
import { CoachJournalService } from '../src/modules/coach-journal/coach-journal.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

interface FakeEntry {
  id: string;
  userId: string;
  date: string;
  mood: number | null;
  energy: number | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  store = new Map<string, FakeEntry>();
  private key(u: string, d: string) {
    return `${u}:${d}`;
  }
  journalEntry = {
    findUnique: async ({
      where,
    }: {
      where: { userId_date: { userId: string; date: string } };
    }) =>
      this.store.get(
        this.key(where.userId_date.userId, where.userId_date.date),
      ) ?? null,
    findMany: async ({
      where,
      orderBy: _o,
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
        const row: FakeEntry = {
          id: 'j_' + Math.random().toString(36).slice(2),
          userId: create.userId,
          date: create.date,
          mood: create.mood ?? null,
          energy: create.energy ?? null,
          content: create.content ?? '',
          createdAt: now,
          updatedAt: now,
        };
        this.store.set(k, row);
        return row;
      }
      const merged: FakeEntry = {
        ...existing,
        ...update,
        updatedAt: new Date(),
      };
      this.store.set(k, merged);
      return merged;
    },
    deleteMany: async ({
      where,
    }: {
      where: { userId: string; date: string };
    }) => {
      const k = this.key(where.userId, where.date);
      const had = this.store.delete(k);
      return { count: had ? 1 : 0 };
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

const DATE = '2026-05-27';

describe('CoachJournalModule (e2e)', () => {
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
      controllers: [CoachJournalController],
      providers: [
        CoachJournalService,
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

  it('POST upserts a journal entry and GET /:date returns it', async () => {
    const post = await request(baseUrl, 'POST', '/coach/journal/entries', {
      userId: USER_A,
      body: { date: DATE, mood: 4, energy: 3, content: '<p>hi</p>' },
    });
    expect([200, 201]).toContain(post.status);
    expect(post.body.mood).toBe(4);

    const get = await request(
      baseUrl,
      'GET',
      `/coach/journal/entries/${DATE}`,
      { userId: USER_A },
    );
    expect(get.status).toBe(200);
    expect(get.body.content).toBe('<p>hi</p>');
  });

  it('PUT /:date/content upserts when row missing', async () => {
    const NEW_DATE = '2026-05-20';
    const res = await request(
      baseUrl,
      'PUT',
      `/coach/journal/entries/${NEW_DATE}/content`,
      {
        userId: USER_A,
        body: { content: '<p>new</p>' },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(NEW_DATE);
    expect(res.body.content).toBe('<p>new</p>');
  });

  it('PUT /:date/mood accepts nulls and upserts', async () => {
    const D = '2026-05-18';
    const res = await request(
      baseUrl,
      'PUT',
      `/coach/journal/entries/${D}/mood`,
      {
        userId: USER_A,
        body: { mood: null, energy: null },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.mood).toBeNull();
    expect(res.body.energy).toBeNull();
  });

  it('DELETE is idempotent', async () => {
    const del1 = await request(
      baseUrl,
      'DELETE',
      `/coach/journal/entries/${DATE}`,
      { userId: USER_A },
    );
    expect(del1.status).toBe(200);
    expect(del1.body.success).toBe(true);
    const del2 = await request(
      baseUrl,
      'DELETE',
      `/coach/journal/entries/${DATE}`,
      { userId: USER_A },
    );
    expect(del2.status).toBe(200);
    expect(del2.body.success).toBe(true);
  });

  it('cross-user isolation: user B GET /:date returns null after A wrote', async () => {
    const D = '2026-05-19';
    await request(baseUrl, 'POST', '/coach/journal/entries', {
      userId: USER_A,
      body: { date: D, content: 'private' },
    });
    const res = await request(
      baseUrl,
      'GET',
      `/coach/journal/entries/${D}`,
      { userId: USER_B },
    );
    expect(res.status).toBe(200);
    expect(res.body === null || res.body === '' || res.rawBody === '').toBe(true);
  });

  it('rejects out-of-range mood with 400', async () => {
    const res = await request(baseUrl, 'POST', '/coach/journal/entries', {
      userId: USER_A,
      body: { date: '2026-05-15', mood: 99 },
    });
    expect(res.status).toBe(400);
  });
});
