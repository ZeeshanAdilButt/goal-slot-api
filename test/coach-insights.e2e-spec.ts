import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as http from 'http';
import { AddressInfo } from 'net';

import { CoachInsightsController } from '../src/modules/coach-insights/coach-insights.controller';
import { CoachInsightsService } from '../src/modules/coach-insights/coach-insights.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

type InsightStatus =
  | 'PROPOSED'
  | 'ACCEPTED'
  | 'DOING'
  | 'DONE'
  | 'DISMISSED'
  | 'SAVED';

interface FakeInsight {
  id: string;
  userId: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  scopeKey: string;
  kind: 'OBSERVATION' | 'SUGGESTION' | 'EXPERIMENT' | 'MEDIA_PROMPT';
  title: string;
  body: string;
  evidence: string;
  suggestedAction: string | null;
  mediaSlot: string | null;
  mediaTopic: string | null;
  status: InsightStatus;
  acceptedAt: Date | null;
  startedDoingAt: Date | null;
  completedAt: Date | null;
  dismissedAt: Date | null;
  savedAt: Date | null;
  userNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function matchesWhere(row: FakeInsight, where: any): boolean {
  if (!where) return true;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.status !== undefined) {
    if (typeof where.status === 'string') {
      if (row.status !== where.status) return false;
    } else if (where.status && Array.isArray(where.status.in)) {
      if (!where.status.in.includes(row.status)) return false;
    }
  }
  return true;
}

class FakePrisma {
  store = new Map<string, FakeInsight>();
  private idCounter = 0;

  seed(row: Omit<FakeInsight, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<FakeInsight, 'id' | 'createdAt' | 'updatedAt'>>): FakeInsight {
    const now = new Date();
    const id = row.id ?? 'ins_' + (++this.idCounter).toString();
    const full: FakeInsight = {
      ...row,
      id,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    } as FakeInsight;
    this.store.set(id, full);
    return full;
  }

  coachInsight = {
    findMany: async ({ where, orderBy: _orderBy }: { where: any; orderBy?: any }) => {
      const rows = Array.from(this.store.values()).filter((r) =>
        matchesWhere(r, where),
      );
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return rows;
    },
    findFirst: async ({ where }: { where: any }) => {
      for (const r of this.store.values()) {
        if (matchesWhere(r, where)) return r;
      }
      return null;
    },
    update: async ({ where, data }: { where: { id: string }; data: any }) => {
      const existing = this.store.get(where.id);
      if (!existing) throw new Error('not found');
      const merged: FakeInsight = {
        ...existing,
        ...data,
        updatedAt: new Date(),
      };
      this.store.set(where.id, merged);
      return merged;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = this.store.get(where.id);
      if (!existing) throw new Error('not found');
      this.store.delete(where.id);
      return existing;
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
  opts: { body?: any; userId?: string; noAuth?: boolean } = {},
): Promise<HttpResp> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    if (!opts.noAuth && opts.userId)
      headers['Authorization'] = `Bearer ${opts.userId}`;
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

describe('CoachInsightsModule (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const fakePrisma = new FakePrisma();
  const USER_A = 'user_A';
  const USER_B = 'user_B';
  let authMode: 'bearer-required' | 'allow-empty' = 'bearer-required';

  beforeAll(async () => {
    const guardStub = {
      canActivate: (ctx: ExecutionContext) => {
        if (authMode === 'allow-empty') return false;
        const req = ctx.switchToHttp().getRequest();
        const auth = req.headers?.authorization as string | undefined;
        if (!auth || !auth.startsWith('Bearer ')) return false;
        req.user = { sub: auth.slice('Bearer '.length) };
        return true;
      },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [CoachInsightsController],
      providers: [
        CoachInsightsService,
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

    // Seed: USER_A has one row in each status plus one for USER_B
    const baseRow = {
      userId: USER_A,
      sourceConversationId: null,
      sourceMessageId: null,
      scopeKey: '2026-W22',
      kind: 'SUGGESTION' as const,
      body: 'body',
      evidence: 'evidence',
      suggestedAction: null,
      mediaSlot: null,
      mediaTopic: null,
      acceptedAt: null,
      startedDoingAt: null,
      completedAt: null,
      dismissedAt: null,
      savedAt: null,
      userNote: null,
    };
    fakePrisma.seed({ ...baseRow, id: 'a_proposed', status: 'PROPOSED', title: 'A proposed' });
    fakePrisma.seed({ ...baseRow, id: 'a_accepted', status: 'ACCEPTED', title: 'A accepted', acceptedAt: new Date() });
    fakePrisma.seed({ ...baseRow, id: 'a_doing', status: 'DOING', title: 'A doing', startedDoingAt: new Date() });
    fakePrisma.seed({ ...baseRow, id: 'a_done', status: 'DONE', title: 'A done', completedAt: new Date() });
    fakePrisma.seed({ ...baseRow, id: 'a_dismissed', status: 'DISMISSED', title: 'A dismissed', dismissedAt: new Date() });
    fakePrisma.seed({ ...baseRow, id: 'a_saved', status: 'SAVED', title: 'A saved', savedAt: new Date() });
    fakePrisma.seed({ ...baseRow, userId: USER_B, id: 'b_proposed', status: 'PROPOSED', title: 'B proposed' });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET / with no filter returns ACTIVE (PROPOSED+ACCEPTED+DOING) only', async () => {
    const res = await request(baseUrl, 'GET', '/coach/insights', { userId: USER_A });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const statuses = res.body.map((r: any) => r.status).sort();
    expect(statuses).toEqual(['ACCEPTED', 'DOING', 'PROPOSED']);
    // All for USER_A
    expect(res.body.every((r: any) => r.userId === USER_A)).toBe(true);
  });

  it('GET /?status=ALL returns everything (including DISMISSED + SAVED) for the user', async () => {
    const res = await request(baseUrl, 'GET', '/coach/insights?status=ALL', { userId: USER_A });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(6);
    const statuses = res.body.map((r: any) => r.status).sort();
    expect(statuses).toEqual(['ACCEPTED', 'DISMISSED', 'DOING', 'DONE', 'PROPOSED', 'SAVED']);
  });

  it('cross-user: user B cannot read user A insight (404)', async () => {
    const res = await request(baseUrl, 'GET', '/coach/insights/a_proposed', { userId: USER_B });
    expect(res.status).toBe(404);
  });

  it('POST /:id/status to ACCEPTED stamps acceptedAt', async () => {
    const fresh = fakePrisma.seed({
      userId: USER_A,
      sourceConversationId: null,
      sourceMessageId: null,
      scopeKey: '2026-W22',
      kind: 'SUGGESTION',
      title: 'to accept',
      body: 'b',
      evidence: 'e',
      suggestedAction: null,
      mediaSlot: null,
      mediaTopic: null,
      status: 'PROPOSED',
      acceptedAt: null,
      startedDoingAt: null,
      completedAt: null,
      dismissedAt: null,
      savedAt: null,
      userNote: null,
    });
    const res = await request(baseUrl, 'POST', `/coach/insights/${fresh.id}/status`, {
      userId: USER_A,
      body: { status: 'ACCEPTED' },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('ACCEPTED');
    expect(res.body.acceptedAt).toBeTruthy();
  });

  it('POST /:id/status to SAVED stamps savedAt', async () => {
    const fresh = fakePrisma.seed({
      userId: USER_A,
      sourceConversationId: null,
      sourceMessageId: null,
      scopeKey: '2026-W22',
      kind: 'MEDIA_PROMPT',
      title: 'to save',
      body: 'b',
      evidence: 'e',
      suggestedAction: null,
      mediaSlot: null,
      mediaTopic: null,
      status: 'PROPOSED',
      acceptedAt: null,
      startedDoingAt: null,
      completedAt: null,
      dismissedAt: null,
      savedAt: null,
      userNote: null,
    });
    const res = await request(baseUrl, 'POST', `/coach/insights/${fresh.id}/status`, {
      userId: USER_A,
      body: { status: 'SAVED' },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('SAVED');
    expect(res.body.savedAt).toBeTruthy();
  });

  it('DELETE on PROPOSED returns 200', async () => {
    const fresh = fakePrisma.seed({
      userId: USER_A,
      sourceConversationId: null,
      sourceMessageId: null,
      scopeKey: '2026-W22',
      kind: 'SUGGESTION',
      title: 'to delete',
      body: 'b',
      evidence: 'e',
      suggestedAction: null,
      mediaSlot: null,
      mediaTopic: null,
      status: 'PROPOSED',
      acceptedAt: null,
      startedDoingAt: null,
      completedAt: null,
      dismissedAt: null,
      savedAt: null,
      userNote: null,
    });
    const res = await request(baseUrl, 'DELETE', `/coach/insights/${fresh.id}`, { userId: USER_A });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE on ACCEPTED returns 409', async () => {
    const res = await request(baseUrl, 'DELETE', `/coach/insights/a_accepted`, { userId: USER_A });
    expect(res.status).toBe(409);
  });

  it('rejects unauthenticated request (guard canActivate=false → 401/403)', async () => {
    authMode = 'allow-empty';
    try {
      const res = await request(baseUrl, 'GET', '/coach/insights', { noAuth: true });
      expect([401, 403]).toContain(res.status);
    } finally {
      authMode = 'bearer-required';
    }
  });
});
