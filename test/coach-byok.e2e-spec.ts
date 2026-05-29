import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';

import { CoachByokController } from '../src/modules/coach-byok/coach-byok.controller';
import { CoachByokService } from '../src/modules/coach-byok/coach-byok.service';
import { EncryptionModule } from '../src/shared/modules/encryption.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

// ---- In-memory Prisma stub ----------------------------------------------------
interface FakeRow {
  id: string;
  userId: string;
  provider: 'OPENAI' | 'ANTHROPIC';
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
  maskedHint: string;
  lastValidatedAt: Date | null;
  tokensUsedThisMonth: number;
  tokensLimit: number;
  tokensWindowStart: Date;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  private store = new Map<string, FakeRow>();

  encryptedByokKey = {
    findUnique: async ({ where }: { where: { userId: string } }) => {
      return this.store.get(where.userId) ?? null;
    },
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
        const row: FakeRow = {
          id: 'row_' + Math.random().toString(36).slice(2),
          userId: where.userId,
          provider: create.provider,
          ciphertext: create.ciphertext,
          iv: create.iv,
          authTag: create.authTag,
          keyVersion: 1,
          maskedHint: create.maskedHint,
          lastValidatedAt: null,
          tokensUsedThisMonth: 0,
          tokensLimit: 100000,
          tokensWindowStart: now,
          createdAt: now,
          updatedAt: now,
        };
        this.store.set(where.userId, row);
        return row;
      }
      const updated: FakeRow = {
        ...existing,
        provider: update.provider ?? existing.provider,
        ciphertext: update.ciphertext ?? existing.ciphertext,
        iv: update.iv ?? existing.iv,
        authTag: update.authTag ?? existing.authTag,
        maskedHint: update.maskedHint ?? existing.maskedHint,
        lastValidatedAt:
          update.lastValidatedAt === undefined
            ? existing.lastValidatedAt
            : update.lastValidatedAt,
        tokensUsedThisMonth:
          update.tokensUsedThisMonth ?? existing.tokensUsedThisMonth,
        tokensWindowStart: update.tokensWindowStart ?? existing.tokensWindowStart,
        updatedAt: new Date(),
      };
      this.store.set(where.userId, updated);
      return updated;
    },
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      const had = this.store.delete(where.userId);
      return { count: had ? 1 : 0 };
    },
  };
}

// ---- Tiny HTTP helper (no supertest dependency) ------------------------------
interface HttpResp {
  status: number;
  body: any;
  rawBody: string;
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  opts: { body?: any; auth?: boolean } = {},
): Promise<HttpResp> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    if (opts.auth) {
      headers['Authorization'] = 'Bearer test-token';
    }
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

describe('CoachByokModule (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const fakePrisma = new FakePrisma();
  const TEST_USER_ID = 'user_test_123';

  beforeAll(async () => {
    // Provide a master key for the EncryptionService during tests.
    process.env.BYOK_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

    // JWT guard stub — authorise only requests with our Bearer header.
    const guardStub = {
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest();
        const auth = req.headers?.authorization as string | undefined;
        if (!auth || !auth.startsWith('Bearer ')) return false;
        req.user = { sub: TEST_USER_ID };
        return true;
      },
    };

    // We build a minimal module that exposes just the controller + service we
    // want to test, with the heavy AuthModule dependency stubbed out (its
    // AuthService transitively requires Supabase, Email, etc).
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EncryptionModule,
      ],
      controllers: [CoachByokController],
      providers: [
        CoachByokService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(guardStub)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
      }),
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

  it('POST /coach/byok-key with a valid OpenAI key returns active state', async () => {
    const res = await request(baseUrl, 'POST', '/coach/byok-key', {
      auth: true,
      body: { provider: 'OPENAI', apiKey: 'sk-test-abcdefgh12345678A4f9' },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('active');
    expect(res.body.provider).toBe('OPENAI');
    expect(res.body.maskedKey).toBe('sk-...A4f9');
  });

  it('GET /coach/byok-key returns the saved masked state', async () => {
    const res = await request(baseUrl, 'GET', '/coach/byok-key', {
      auth: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.provider).toBe('OPENAI');
    expect(res.body.maskedKey).toBe('sk-...A4f9');
  });

  it('POST /coach/byok-key with a wrong-prefix key returns 400', async () => {
    const res = await request(baseUrl, 'POST', '/coach/byok-key', {
      auth: true,
      body: { provider: 'OPENAI', apiKey: 'xyz-not-a-real-prefix-1234' },
    });
    expect(res.status).toBe(400);
  });

  it('POST with an Anthropic key replaces the existing OpenAI key', async () => {
    const res = await request(baseUrl, 'POST', '/coach/byok-key', {
      auth: true,
      body: {
        provider: 'ANTHROPIC',
        apiKey: 'sk-ant-abcdefghijklmnopABCD',
      },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('active');
    expect(res.body.provider).toBe('ANTHROPIC');
    expect(res.body.maskedKey).toBe('sk-ant-...ABCD');

    const after = await request(baseUrl, 'GET', '/coach/byok-key', {
      auth: true,
    });
    expect(after.body.provider).toBe('ANTHROPIC');
    expect(after.body.maskedKey).toBe('sk-ant-...ABCD');
  });

  it('DELETE removes the key and a subsequent GET reports unset', async () => {
    const del = await request(baseUrl, 'DELETE', '/coach/byok-key', {
      auth: true,
    });
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const get = await request(baseUrl, 'GET', '/coach/byok-key', {
      auth: true,
    });
    expect(get.status).toBe(200);
    expect(get.body.status).toBe('unset');
  });

  it('returns 401/403 when no Authorization header is present', async () => {
    const res = await request(baseUrl, 'GET', '/coach/byok-key', {
      auth: false,
    });
    // Nest's default for a failing guard is 403; passport-jwt would 401.
    // Our stub returns false → 403.
    expect([401, 403]).toContain(res.status);
  });
});

