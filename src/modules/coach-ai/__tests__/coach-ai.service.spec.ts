import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CoachInsightStatus,
  CoachRole,
  CoachScope,
  ReligiousContext,
} from '@prisma/client';

import {
  CoachAiService,
  formatMemoryBlock,
  normalizedSimilarity,
} from '../coach-ai.service';
import { LlmFactory } from '../../../shared/services/llm/llm-factory';
import {
  CoachLlmProvider,
  LlmChatMessage,
  LlmStreamChunk,
  LlmUsage,
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

interface FakeInsight {
  id: string;
  userId: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  scopeKey: string;
  kind: string;
  title: string;
  body: string;
  evidence: string;
  suggestedAction: string | null;
  mediaSlot: string | null;
  mediaTopic: string | null;
  status: CoachInsightStatus;
  acceptedAt: Date | null;
  startedDoingAt: Date | null;
  completedAt: Date | null;
  dismissedAt: Date | null;
  savedAt: Date | null;
  userNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeHabits {
  userId: string;
  why?: string;
  religiousContext?: ReligiousContext;
  spiritualNotes?: string;
  sleepTargetHours?: number;
  bedtime?: string;
  wakeTime?: string;
  workEnvironment?: string;
  additionalContext?: string;
}

class FakePrisma {
  byok = new Map<string, FakeByok>();
  conversations: FakeConv[] = [];
  messages: FakeMsg[] = [];
  insights: FakeInsight[] = [];
  habits: Map<string, FakeHabits> = new Map();
  scheduleBlocksRows: any[] = [];

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

  coachInsight = {
    findMany: async ({ where, orderBy: _ob, take }: any) => {
      this.calls.push({ op: 'coachInsight.findMany', meta: where });
      let rows = this.insights.filter((i) => i.userId === where.userId);
      if (where.status?.in) {
        rows = rows.filter((i) => where.status.in.includes(i.status));
      } else if (where.status) {
        rows = rows.filter((i) => i.status === where.status);
      }
      // sort by startedDoingAt desc, then acceptedAt desc
      rows.sort((a, b) => {
        const aT = (a.startedDoingAt ?? a.acceptedAt ?? new Date(0)).getTime();
        const bT = (b.startedDoingAt ?? b.acceptedAt ?? new Date(0)).getTime();
        return bT - aT;
      });
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
    create: async ({ data }: any) => {
      this.calls.push({ op: 'coachInsight.create', meta: data });
      const now = new Date();
      const row: FakeInsight = {
        id: 'ins_' + this.insights.length,
        userId: data.userId,
        sourceConversationId: data.sourceConversationId ?? null,
        sourceMessageId: data.sourceMessageId ?? null,
        scopeKey: data.scopeKey,
        kind: data.kind,
        title: data.title,
        body: data.body,
        evidence: data.evidence,
        suggestedAction: data.suggestedAction ?? null,
        mediaSlot: data.mediaSlot ?? null,
        mediaTopic: data.mediaTopic ?? null,
        status: data.status ?? 'PROPOSED',
        acceptedAt: data.acceptedAt ?? null,
        startedDoingAt: data.startedDoingAt ?? null,
        completedAt: data.completedAt ?? null,
        dismissedAt: data.dismissedAt ?? null,
        savedAt: data.savedAt ?? null,
        userNote: data.userNote ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.insights.push(row);
      return row;
    },
  };

  habitsProfile = {
    findUnique: async ({ where }: any) => {
      this.calls.push({ op: 'habits.findUnique' });
      return this.habits.get(where.userId) ?? null;
    },
  };
  dailyCheckin = { findMany: async () => [] };
  journalEntry = { findMany: async () => [] };
  goal = { findMany: async () => [] };
  goalReflection = { findMany: async () => [] };
  timeEntry = { groupBy: async () => [] };
  scheduleBlock = {
    findMany: async () => {
      this.calls.push({ op: 'scheduleBlock.findMany' });
      return this.scheduleBlocksRows;
    },
  };

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
    async extractStructured<T = unknown>(_args: any) {
      // default: empty insight payload, zero usage
      return {
        data: { insights: [] } as unknown as T,
        usage: { promptTokens: 0, completionTokens: 0 } as LlmUsage,
      };
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

// Wait for any pending microtasks/promises (used after streaming so the
// detached extractInsightsAsync .catch settles before assertions).
async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

// ---------- Tests ----------

describe('CoachAiService', () => {
  let prisma: FakePrisma;
  let encryption: FakeEncryption;
  let factory: LlmFactory;
  let service: CoachAiService;
  let createSpy: jest.SpyInstance;
  let extractStructuredFn: jest.Mock;

  beforeEach(() => {
    prisma = new FakePrisma();
    encryption = new FakeEncryption();
    factory = new LlmFactory();
    extractStructuredFn = jest.fn().mockResolvedValue({
      data: { insights: [] },
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    createSpy = jest.spyOn(factory, 'create').mockReturnValue({
      async *streamCompletion(
        _messages: LlmChatMessage[],
        _model: string,
      ): AsyncIterable<LlmStreamChunk> {
        yield { delta: 'Hello', done: false };
        yield { delta: ' world', done: false };
        yield {
          delta: '',
          done: true,
          usage: { promptTokens: 42, completionTokens: 7 },
        };
      },
      extractStructured: extractStructuredFn as any,
    });
    service = new CoachAiService(prisma as any, encryption as any, factory);
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

    expect(out[out.length - 1]).toEqual({ delta: '', done: true });
    await flushMicrotasks();

    const row = prisma.byok.get('user_1')!;
    // 42 + 7 from the narrative stream. Extraction call usage is 0 in the
    // default mock so this stays 49.
    expect(row.tokensUsedThisMonth).toBe(49);
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

    // Extraction must NOT be invoked when we returned a cached narrative.
    expect(extractStructuredFn).not.toHaveBeenCalled();
  });

  it('chat POST persists the USER message BEFORE invoking the provider', async () => {
    prisma.byok.set('user_1', freshByok());

    const callOrder: string[] = [];
    const origCreate = prisma.coachMessage.create.bind(prisma.coachMessage);
    prisma.coachMessage.create = (async (args: any) => {
      callOrder.push(`msg.create:${args.data.role}`);
      return origCreate(args);
    }) as any;
    createSpy.mockImplementation((..._args: any[]) => {
      callOrder.push('factory.create');
      return {
        ...makeFakeProvider([
          { delta: 'reply', done: false },
          {
            delta: '',
            done: true,
            usage: { promptTokens: 10, completionTokens: 5 },
          },
        ]),
        extractStructured: extractStructuredFn,
      };
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

  // ---------- NEW: extraction tests ----------

  it('invokes extractStructured after a successful narrative stream', async () => {
    prisma.byok.set('user_1', freshByok());
    await drain(service.streamNarrative('user_1', '2026-W22', false));
    await flushMicrotasks();

    expect(extractStructuredFn).toHaveBeenCalledTimes(1);
    const firstCallArg = extractStructuredFn.mock.calls[0][0];
    expect(firstCallArg.schemaName).toBe('extract_coach_insights');
    expect(firstCallArg.model).toBe('gpt-4o-mini');
    expect(Array.isArray(firstCallArg.messages)).toBe(true);
    expect(firstCallArg.messages[0].role).toBe('system');
  });

  it('does NOT invoke extractStructured after a chat reply', async () => {
    prisma.byok.set('user_1', freshByok());
    await drain(service.streamChatReply('user_1', '2026-W22', 'hello'));
    await flushMicrotasks();

    expect(extractStructuredFn).not.toHaveBeenCalled();
  });

  it('persists extracted insights with sourceConversationId, sourceMessageId, scopeKey', async () => {
    prisma.byok.set('user_1', freshByok());
    extractStructuredFn.mockResolvedValueOnce({
      data: {
        insights: [
          {
            kind: 'SUGGESTION',
            title: '60-min Deep Work block',
            body: 'Block 09:00-10:00 Mon/Wed/Fri for your top goal.',
            evidence: 'Wed/Thu had 0 minutes logged on your top goal.',
            suggestedAction: 'Schedule a 60-min block for Mon/Wed/Fri 09:00',
          },
        ],
      },
      usage: { promptTokens: 200, completionTokens: 100 },
    });

    await drain(service.streamNarrative('user_1', '2026-W22', false));
    await flushMicrotasks();

    expect(prisma.insights).toHaveLength(1);
    const ins = prisma.insights[0];
    expect(ins.title).toBe('60-min Deep Work block');
    expect(ins.kind).toBe('SUGGESTION');
    expect(ins.scopeKey).toBe('2026-W22');
    expect(ins.sourceConversationId).toBeTruthy();
    expect(ins.sourceMessageId).toBeTruthy();
    // The narrative message id should be the persisted one.
    const narrativeMsg = prisma.messages.find(
      (m) => m.role === CoachRole.SYSTEM_NARRATIVE,
    );
    expect(ins.sourceMessageId).toBe(narrativeMsg!.id);

    // Token counter should reflect BOTH the narrative (49) and the extraction
    // call usage (200 + 100 = 300) = 349.
    const row = prisma.byok.get('user_1')!;
    expect(row.tokensUsedThisMonth).toBe(49 + 300);
  });

  it('drops items whose title is a near-duplicate of an active insight', async () => {
    prisma.byok.set('user_1', freshByok());
    // Pre-seed an accepted insight.
    const now = new Date();
    prisma.insights.push({
      id: 'ins_seed',
      userId: 'user_1',
      sourceConversationId: null,
      sourceMessageId: null,
      scopeKey: '2026-W21',
      kind: 'SUGGESTION',
      title: '60-min Deep Work block',
      body: '...',
      evidence: '...',
      suggestedAction: 'Block 09:00-10:00 Mon/Wed/Fri',
      mediaSlot: null,
      mediaTopic: null,
      status: 'ACCEPTED' as CoachInsightStatus,
      acceptedAt: now,
      startedDoingAt: null,
      completedAt: null,
      dismissedAt: null,
      savedAt: null,
      userNote: null,
      createdAt: now,
      updatedAt: now,
    });

    extractStructuredFn.mockResolvedValueOnce({
      data: {
        insights: [
          {
            // near-duplicate of the seeded title — should be dropped
            kind: 'SUGGESTION',
            title: '60-min deep work block',
            body: 'Same idea, restated.',
            evidence: 'evidence',
          },
          {
            // genuinely new — should survive
            kind: 'OBSERVATION',
            title: 'Mood crashes on Wednesdays',
            body: 'Mood 3/5 each Wed for 3 weeks.',
            evidence: 'Wed mood = 3, Mon avg = 4.2',
          },
        ],
      },
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    await drain(service.streamNarrative('user_1', '2026-W22', false));
    await flushMicrotasks();

    // 1 seeded + 1 survivor inserted = 2 rows.
    expect(prisma.insights.length).toBe(2);
    const newOnes = prisma.insights.filter((i) => i.scopeKey === '2026-W22');
    expect(newOnes).toHaveLength(1);
    expect(newOnes[0].title).toBe('Mood crashes on Wednesdays');
  });

  it('does NOT include spiritual framing in narrative prompt when religiousContext=NONE', async () => {
    prisma.byok.set('user_1', freshByok());
    prisma.habits.set('user_1', {
      userId: 'user_1',
      why: 'Build a thing people love',
      religiousContext: ReligiousContext.NONE,
      spiritualNotes: 'should never appear',
      sleepTargetHours: 8,
      bedtime: '23:00',
      wakeTime: '07:00',
      workEnvironment: 'home office',
    });

    let capturedUserMessage = '';
    createSpy.mockImplementation((..._args: any[]) => ({
      async *streamCompletion(messages: LlmChatMessage[], _model: string) {
        const u = messages.find((m) => m.role === 'user');
        if (u) capturedUserMessage = u.content;
        yield { delta: 'ok', done: false };
        yield {
          delta: '',
          done: true,
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
      extractStructured: extractStructuredFn,
    }));

    await drain(service.streamNarrative('user_1', '2026-W22', false));

    expect(capturedUserMessage.toLowerCase()).not.toContain('barakah');
    expect(capturedUserMessage.toLowerCase()).not.toContain('salah');
    expect(capturedUserMessage.toLowerCase()).not.toContain('ihsan');
    // spiritualNotes is hidden when religiousContext is NONE.
    expect(capturedUserMessage).not.toContain('should never appear');
    expect(capturedUserMessage).toContain('religiousContext: NONE');
  });

  it('includes the memory block in narrative AND chat prompts when accepted insights exist', async () => {
    prisma.byok.set('user_1', freshByok());
    const seededAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    prisma.insights.push({
      id: 'ins_seed',
      userId: 'user_1',
      sourceConversationId: null,
      sourceMessageId: null,
      scopeKey: '2026-W20',
      kind: 'SUGGESTION',
      title: '60-min Deep Work block',
      body: '...',
      evidence: '...',
      suggestedAction: 'Block 09:00-10:00 Mon/Wed/Fri',
      mediaSlot: null,
      mediaTopic: null,
      status: 'DOING' as CoachInsightStatus,
      acceptedAt: seededAt,
      startedDoingAt: seededAt,
      completedAt: null,
      dismissedAt: null,
      savedAt: null,
      userNote: null,
      createdAt: seededAt,
      updatedAt: seededAt,
    });

    const capturedUserMessages: string[] = [];
    createSpy.mockImplementation((..._args: any[]) => ({
      async *streamCompletion(messages: LlmChatMessage[], _model: string) {
        const u = messages.find((m) => m.role === 'user');
        if (u) capturedUserMessages.push(u.content);
        yield { delta: 'ok', done: false };
        yield {
          delta: '',
          done: true,
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
      extractStructured: extractStructuredFn,
    }));

    await drain(service.streamNarrative('user_1', '2026-W22', false));
    await drain(service.streamChatReply('user_1', '2026-W22', 'how am I?'));

    expect(capturedUserMessages.length).toBeGreaterThanOrEqual(2);
    for (const msg of capturedUserMessages) {
      expect(msg).toContain("What you've already suggested");
      expect(msg).toContain('60-min Deep Work block');
      expect(msg).toMatch(/status=DOING/);
    }
  });
});

// ---------- Helper unit tests ----------

describe('normalizedSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(normalizedSimilarity('hello', 'hello')).toBe(1);
  });
  it('returns 0 for completely different strings of same length', () => {
    expect(normalizedSimilarity('abc', 'xyz')).toBeCloseTo(0, 5);
  });
  it('returns > 0.85 for near-duplicate titles', () => {
    expect(
      normalizedSimilarity('60-min deep work block', '60-min Deep Work block'.toLowerCase()),
    ).toBe(1);
    expect(
      normalizedSimilarity(
        '60-min deep work block',
        '60 min deep work block',
      ),
    ).toBeGreaterThan(0.9);
  });
});

describe('formatMemoryBlock', () => {
  it('returns empty string when no insights', () => {
    expect(formatMemoryBlock([])).toBe('');
  });

  it('formats with status and suggestedAction when present', () => {
    const now = new Date();
    const txt = formatMemoryBlock(
      [
        {
          id: 'a',
          userId: 'u',
          sourceConversationId: null,
          sourceMessageId: null,
          scopeKey: '2026-W22',
          kind: 'SUGGESTION',
          title: '60-min Deep Work block',
          body: 'b',
          evidence: 'e',
          suggestedAction: 'Block 09:00-10:00',
          mediaSlot: null,
          mediaTopic: null,
          status: 'DOING',
          acceptedAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
          startedDoingAt: now,
          completedAt: null,
          dismissedAt: null,
          savedAt: null,
          userNote: null,
          createdAt: now,
          updatedAt: now,
        } as any,
      ],
      800,
      now,
    );
    expect(txt).toContain('60-min Deep Work block');
    expect(txt).toContain('Block 09:00-10:00');
    expect(txt).toContain('status=DOING');
    expect(txt).toMatch(/2 weeks ago|this week|last week/);
  });

  it('FIFO-trims when over the 800-char cap (oldest dropped first)', () => {
    const now = new Date();
    const make = (id: string, weeksOld: number, title: string): any => ({
      id,
      userId: 'u',
      sourceConversationId: null,
      sourceMessageId: null,
      scopeKey: '2026-W22',
      kind: 'SUGGESTION',
      title,
      body: 'b',
      evidence: 'e',
      suggestedAction: 'x'.repeat(150),
      mediaSlot: null,
      mediaTopic: null,
      status: 'ACCEPTED',
      acceptedAt: new Date(
        now.getTime() - weeksOld * 7 * 24 * 60 * 60 * 1000,
      ),
      startedDoingAt: null,
      completedAt: null,
      dismissedAt: null,
      savedAt: null,
      userNote: null,
      createdAt: now,
      updatedAt: now,
    });

    const insights = [
      make('a', 10, 'OLDEST'),
      make('b', 5, 'MIDDLE'),
      make('c', 1, 'NEWEST'),
    ];
    const txt = formatMemoryBlock(insights, 400, now);
    expect(txt.length).toBeLessThanOrEqual(400);
    // OLDEST should be the first to drop.
    expect(txt).not.toContain('OLDEST');
    expect(txt).toContain('NEWEST');
  });
});
