import { HttpException, HttpStatus } from '@nestjs/common';
import { CoachRole, CoachScope } from '@prisma/client';

import { CoachAiService } from '../coach-ai.service';
import { LlmFactory } from '../../../shared/services/llm/llm-factory';
import {
  CoachLlmProvider,
  LlmChatMessage,
  LlmStreamChunk,
} from '../../../shared/services/llm/llm.interface';

// ---------- Fakes ----------

interface FakeByok {
  userId: string;
  provider: 'OPENAI' | 'ANTHROPIC';
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
  maskedHint: string;
  lastValidatedAt: Date | null;
  tokensUsedThisMonth: number;
  tokensLimit: number;
  tokensWindowStart: Date;
}

interface FakeConv {
  id: string;
  userId: string;
  scope: CoachScope;
  scopeKey: string;
}

interface FakeMsg {
  id: string;
  conversationId: string;
  role: CoachRole;
  content: string;
  promptTokens: number;
  completionTokens: number;
  model: string | null;
  createdAt: Date;
}

class FakePrisma {
  byok = new Map<string, FakeByok>();
  conversations: FakeConv[] = [];
  messages: FakeMsg[] = [];

  // Call log for assertions about ordering.
  calls: Array<{ op: string; meta?: any }> = [];

  encryptedByokKey = {
    findUnique: async ({ where }: any) => {
      this.calls.push({ op: 'byok.findUnique' });
      return this.byok.get(where.userId) ?? null;
    },
    update: async ({ where, data }: any) => {
      this.calls.push({ op: 'byok.update', meta: data });
      const row = this.byok.get(where.userId);
      if (!row) throw new Error('byok not found');
      if (data.tokensUsedThisMonth?.increment !== undefined) {
        row.tokensUsedThisMonth += data.tokensUsedThisMonth.increment;
      } else if (typeof data.tokensUsedThisMonth === 'number') {
        row.tokensUsedThisMonth = data.tokensUsedThisMonth;
      }
      if (data.tokensWindowStart instanceof Date) {
        row.tokensWindowStart = data.tokensWindowStart;
      }
      if (data.lastValidatedAt instanceof Date) {
        row.lastValidatedAt = data.lastValidatedAt;
      }
      return row;
    },
  };

  coachConversation = {
    findUnique: async ({ where }: any) => {
      this.calls.push({ op: 'conv.findUnique' });
      const k = where.userId_scope_scopeKey;
      return (
        this.conversations.find(
          (c) =>
            c.userId === k.userId &&
            c.scope === k.scope &&
            c.scopeKey === k.scopeKey,
        ) ?? null
      );
    },
    create: async ({ data }: any) => {
      this.calls.push({ op: 'conv.create' });
      const row: FakeConv = {
        id: 'conv_' + this.conversations.length,
        userId: data.userId,
        scope: data.scope,
        scopeKey: data.scopeKey,
      };
      this.conversations.push(row);
      return row;
    },
  };

  coachMessage = {
    findFirst: async ({ where, orderBy: _ob }: any) => {
      this.calls.push({ op: 'msg.findFirst' });
      const rows = this.messages.filter(
        (m) =>
          m.conversationId === where.conversationId &&
          (where.role?.in ? where.role.in.includes(m.role) : true),
      );
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows[0] ?? null;
    },
    findMany: async ({ where }: any) => {
      this.calls.push({ op: 'msg.findMany' });
      return this.messages
        .filter((m) => m.conversationId === where.conversationId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    create: async ({ data }: any) => {
      this.calls.push({ op: 'msg.create', meta: { role: data.role } });
      const row: FakeMsg = {
        id: 'msg_' + this.messages.length,
        conversationId: data.conversationId,
        role: data.role,
        content: data.content,
        promptTokens: data.promptTokens ?? 0,
        completionTokens: data.completionTokens ?? 0,
        model: data.model ?? null,
        createdAt: new Date(Date.now() + this.messages.length), // monotonic
      };
      this.messages.push(row);
      return row;
    },
  };

  habitsProfile = { findUnique: async () => null };
  dailyCheckin = { findMany: async () => [] };
  journalEntry = { findMany: async () => [] };
  goal = { findMany: async () => [] };
  goalReflection = { findMany: async () => [] };
  timeEntry = { groupBy: async () => [] };

  // $transaction accepts an array of pre-built promises and resolves them.
  $transaction = async (ops: Promise<any>[]) => {
    this.calls.push({ op: '$transaction' });
    return Promise.all(ops);
  };
}

class FakeEncryption {
  decrypt(_p: any): string {
    return 'sk-fake-decrypted-key';
  }
  encrypt() {
    return {
      ciphertext: Buffer.from('x'),
      iv: Buffer.from('y'),
      authTag: Buffer.from('z'),
    };
  }
}

function makeFakeProvider(chunks: LlmStreamChunk[]): CoachLlmProvider {
  return {
    async *streamCompletion(
      _messages: LlmChatMessage[],
      _model: string,
    ): AsyncIterable<LlmStreamChunk> {
      for (const c of chunks) yield c;
    },
  };
}

function freshByok(overrides: Partial<FakeByok> = {}): FakeByok {
  return {
    userId: 'user_1',
    provider: 'OPENAI',
    ciphertext: new Uint8Array([1, 2, 3]),
    iv: new Uint8Array([4, 5, 6]),
    authTag: new Uint8Array([7, 8, 9]),
    keyVersion: 1,
    maskedHint: 'sk-...abcd',
    lastValidatedAt: null,
    tokensUsedThisMonth: 0,
    tokensLimit: 100_000,
    tokensWindowStart: new Date(),
    ...overrides,
  };
}

async function drain(
  gen: AsyncGenerator<{ delta: string; done: boolean; error?: string }>,
): Promise<Array<{ delta: string; done: boolean; error?: string }>> {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ---------- Tests ----------

describe('CoachAiService', () => {
  let prisma: FakePrisma;
  let encryption: FakeEncryption;
  let factory: LlmFactory;
  let service: CoachAiService;
  let createSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = new FakePrisma();
    encryption = new FakeEncryption();
    factory = new LlmFactory();
    createSpy = jest
      .spyOn(factory, 'create')
      .mockReturnValue(
        makeFakeProvider([
          { delta: 'Hello', done: false },
          { delta: ' world', done: false },
          {
            delta: '',
            done: true,
            usage: { promptTokens: 42, completionTokens: 7 },
          },
        ]),
      );
    service = new CoachAiService(
      prisma as any,
      encryption as any,
      factory,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws 412 when no BYOK key is configured', async () => {
    await expect(
      drain(service.streamNarrative('user_missing', '2026-W22', false)),
    ).rejects.toMatchObject({ status: HttpStatus.PRECONDITION_FAILED });
  });

  it('throws 429 when tokensUsedThisMonth >= tokensLimit', async () => {
    prisma.byok.set(
      'user_1',
      freshByok({ tokensUsedThisMonth: 100_000, tokensLimit: 100_000 }),
    );
    try {
      await drain(service.streamNarrative('user_1', '2026-W22', false));
      fail('expected 429');
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const body = err.getResponse() as any;
      expect(body.tokensUsed).toBe(100_000);
      expect(body.tokensLimit).toBe(100_000);
    }
  });

  it('increments the token counter by promptTokens + completionTokens after stream end', async () => {
    prisma.byok.set('user_1', freshByok());
    const out = await drain(
      service.streamNarrative('user_1', '2026-W22', false),
    );

    // Last chunk is the terminal done.
    expect(out[out.length - 1]).toEqual({ delta: '', done: true });

    const row = prisma.byok.get('user_1')!;
    expect(row.tokensUsedThisMonth).toBe(49); // 42 + 7
  });

  it('persists a SYSTEM_NARRATIVE CoachMessage when scope is NARRATIVE', async () => {
    prisma.byok.set('user_1', freshByok());
    await drain(service.streamNarrative('user_1', '2026-W22', false));

    const created = prisma.messages.find(
      (m) => m.role === CoachRole.SYSTEM_NARRATIVE,
    );
    expect(created).toBeDefined();
    expect(created!.content).toBe('Hello world');
    expect(created!.promptTokens).toBe(42);
    expect(created!.completionTokens).toBe(7);
    expect(created!.model).toBe('gpt-4o-mini');
  });

  it('persists an ASSISTANT CoachMessage when scope is CHAT', async () => {
    prisma.byok.set('user_1', freshByok());
    await drain(service.streamChatReply('user_1', '2026-W22', 'hi coach'));

    const assistant = prisma.messages.find(
      (m) => m.role === CoachRole.ASSISTANT,
    );
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Hello world');
    expect(assistant!.promptTokens).toBe(42);
    expect(assistant!.completionTokens).toBe(7);
  });

  it('returns cached narrative without invoking LlmFactory when one exists and force=false', async () => {
    prisma.byok.set('user_1', freshByok());
    // Pre-seed a cached narrative.
    const conv = await prisma.coachConversation.create({
      data: {
        userId: 'user_1',
        scope: CoachScope.NARRATIVE,
        scopeKey: '2026-W22',
      },
    });
    await prisma.coachMessage.create({
      data: {
        conversationId: conv.id,
        role: CoachRole.SYSTEM_NARRATIVE,
        content: 'cached narrative text',
        promptTokens: 100,
        completionTokens: 50,
        model: 'gpt-4o-mini',
      },
    });

    // Reset call log so we can assert no provider invocation below.
    prisma.calls = [];
    createSpy.mockClear();

    const out = await drain(
      service.streamNarrative('user_1', '2026-W22', false),
    );

    expect(createSpy).not.toHaveBeenCalled();
    expect(out[0]).toEqual({ delta: 'cached narrative text', done: false });
    expect(out[out.length - 1]).toEqual({ delta: '', done: true });

    // Token counter must NOT advance on cache hits.
    const row = prisma.byok.get('user_1')!;
    expect(row.tokensUsedThisMonth).toBe(0);
  });

  it('chat POST persists the USER message BEFORE invoking the provider', async () => {
    prisma.byok.set('user_1', freshByok());

    const callOrder: string[] = [];
    // Tag the moments we care about.
    const origCreate = prisma.coachMessage.create.bind(prisma.coachMessage);
    prisma.coachMessage.create = (async (args: any) => {
      callOrder.push(`msg.create:${args.data.role}`);
      return origCreate(args);
    }) as any;
    createSpy.mockImplementation((...args: any[]) => {
      callOrder.push('factory.create');
      return makeFakeProvider([
        { delta: 'reply', done: false },
        {
          delta: '',
          done: true,
          usage: { promptTokens: 10, completionTokens: 5 },
        },
      ]);
    });

    await drain(service.streamChatReply('user_1', '2026-W22', 'help me'));

    const userIdx = callOrder.indexOf(`msg.create:${CoachRole.USER}`);
    const factoryIdx = callOrder.indexOf('factory.create');
    const assistantIdx = callOrder.indexOf(
      `msg.create:${CoachRole.ASSISTANT}`,
    );
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(factoryIdx).toBeGreaterThan(userIdx);
    expect(assistantIdx).toBeGreaterThan(factoryIdx);
  });
});
