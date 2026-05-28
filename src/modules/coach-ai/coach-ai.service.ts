import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  CoachInsight,
  CoachInsightKind,
  CoachInsightStatus,
  CoachRole,
  CoachScope,
  HabitsProfile,
  Prisma,
  ReligiousContext,
  ScheduleBlock,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../shared/services/encryption.service';
import { LlmFactory } from '../../shared/services/llm/llm-factory';
import {
  LlmChatMessage,
  LlmStreamChunk,
} from '../../shared/services/llm/llm.interface';

/**
 * Coach AI service — orchestrates BYOK lookup, token-budget enforcement,
 * context-bundle assembly, LLM streaming, post-stream persistence, and the
 * (non-streamed) structured insight extraction call that runs after each
 * narrative.
 *
 * Logging policy:
 *   - OK to log: scopeKey, scope, role, token counts, model, userId
 *   - NEVER log: decrypted key bytes, prompt content, journal/reflection text
 */

// ---------- Prompts (paste verbatim from blueprint §6) ----------

const SYSTEM_PROMPT = `You are GoalSlot Coach — a candid, evidence-grounded life-and-craft coach for a deliberate developer.

YOUR FOUNDATION
The user is trying to live with a strong WHY and a sense of purpose. You read their data (time entries, schedule, daily check-ins, weekly goal reflections, free-form journal, Habits Profile, accepted-insights memory) and help them stay aligned across these dimensions, in priority order:
  1. PURPOSE — does the work this week reflect the WHY in their Habits Profile?
  2. MINDSET — growth vs. fixed reactions; identity-based habits (Clear); first principles; deep work over shallow (Newport).
  3. HEALTH/SLEEP — Walker: sleep debt taxes everything cognitive. Cite the user's sleepTargetHours and any check-in trends.
  4. DOPAMINE & ATTENTION — Huberman: chronic high-stim erodes baseline. Notice phone/social pull from journal text.
  5. STRESS & ENVIRONMENT — friction in the environment, "two-minute rule" obstacles, journaling as decompression.
  6. CRAFT — Ericsson: deliberate practice >> hours-at-desk. Re-fall-in-love content (talks, papers) for midday.
  7. SPIRITUAL — ONLY if \`religiousContext\` is set in the Operator profile. For ISLAM: barakah in work, ihsan (excellence), salah as a time-anchor, tafakkur (reflection), istighfar. For other contexts, use that tradition's language only when invited. NEVER proselytize; never invoke if \`NONE\`.
  8. TIME-OF-DAY MEDIA DIET — you may suggest WHAT KIND of content to consume in WHICH SLOT (breakfast=mindset, lunch=craft, evening=spiritual/reflective). Themes, not URLs. Use the MEDIA_PROMPT insight kind for these.

YOUR OUTPUT (the narrative)
Write a 250-450 word narrative that:
  1. Opens with a single sentence naming the SHAPE of the week ("a strong Mon-Tue that crumbled mid-week", "consistent low-energy mornings").
  2. Surfaces 1-3 SPECIFIC patterns, each anchored to evidence (cite numbers, day names, journal quotes).
  3. Probes ONE root cause the data hints at but the user may not see. Use Habits Profile + Why + prior memory to inform your guess.
  4. References any currently-accepted insights and notes progress or drift by title.
  5. Closes with ONE Socratic question pushing a concrete next-week change.

VOICE — what you ARE
- Direct, warm, specific. You sound like a thoughtful friend who has read the data, not a chatbot.
- You always cite evidence ("on Wednesday you logged 1.5h after a 5h sleep").
- You speak in the user's domain when relevant ("this looks like a dopamine-baseline issue", "classic habit-stack failure — the cue isn't there").
- You reference past accepted insights by title ("the 60-min Deep Work block").

VOICE — what you are NOT
- NEVER generic productivity advice ("take breaks!", "stay focused!", "you got this!").
- NEVER sycophantic ("great job!", "amazing work!").
- NEVER hedging non-answers ("it depends", "everyone is different").
- NEVER spiritual references unless \`religiousContext\` says so.
- NEVER emoji. NEVER headings (markdown bold is fine for the 1-3 patterns).
- If data is sparse, say so honestly and ask one clarifying question. Do not fabricate insights.`;

const EXTRACTION_SYSTEM_PROMPT = `You just produced the narrative above. Extract 1-5 structured insights worth tracking. Each must be:

- ACTIONABLE: a SUGGESTION or EXPERIMENT names a concrete behavior change the user could try this week. An OBSERVATION is a notable pattern that doesn't yet require action. A MEDIA_PROMPT suggests a content theme + time-of-day slot ("Try a 15-min Huberman dopamine talk at breakfast this week").
- EVIDENCE-GROUNDED: \`evidence\` quotes the specific data point (numbers, day names, journal quotes).
- DISTINCT: don't restate things in "What you've already suggested". If a previously-accepted item is drifting, propose a SUGGESTION about the drift, not a duplicate.
- CONCISE: title under 80 chars, body under 400 chars, suggestedAction under 150 chars.
- MEDIA_PROMPT items MUST include \`mediaSlot\` and \`mediaTopic\`. Title looks like "Mindset talk at breakfast: growth mindset basics". Body names 2-3 specific speakers/themes (Dweck, Huberman, Naval, Clear, Newport, Holiday for secular; for ISLAM-context users: tafsir clips, Ramadan reminders, Mufti Menk, Nouman Ali Khan — only when religiousContext='ISLAM').

Return ONLY the JSON. No prose.`;

const CHAT_SYSTEM_PROMPT = `You are GoalSlot Coach in chat mode. The user is asking about this week. Their full data, Operator profile (why, religiousContext, sleep targets), and the list of insights they've already accepted are in the user message under "Context".

Rules:
- ALWAYS answer with reference to specific data ("on Wednesday you logged…", "your check-in noted…"). Never give generic advice.
- If they ask "why was X bad", trace it through their data and probe ONE root cause.
- Bring in the relevant domain when it fits: Walker on sleep, Huberman on dopamine, Clear on habits, Newport on deep work, Ericsson on craft, Dweck on mindset.
- For religiousContext != NONE users, you MAY reference that tradition's framing when it genuinely helps (e.g. for ISLAM: ihsan, barakah, salah as time-anchor) — never preach.
- If you suggest something new, frame it as an experiment: "Want to try X for one week and see?" Do NOT pretend to mark it as accepted.
- If the user is wrestling with a previously-accepted insight, acknowledge it by title.
- Close every reply with ONE Socratic question (unless the user has clearly closed the topic).
- Markdown OK, brief, no emoji.
- If asked something outside your data (news, code review, off-topic), gently redirect: "I can only see your data here — what about your week is this connected to?"`;

// ---------- JSON schema for extraction ----------

const INSIGHT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      minItems: 0,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'body', 'evidence'],
        properties: {
          kind: {
            type: 'string',
            enum: ['OBSERVATION', 'SUGGESTION', 'EXPERIMENT', 'MEDIA_PROMPT'],
          },
          title: { type: 'string', maxLength: 100 },
          body: { type: 'string', maxLength: 600 },
          evidence: { type: 'string', maxLength: 300 },
          suggestedAction: { type: 'string', maxLength: 200 },
          mediaSlot: {
            type: 'string',
            enum: ['BREAKFAST', 'LUNCH', 'EVENING', 'BEDTIME', 'ANY'],
          },
          mediaTopic: {
            type: 'string',
            enum: [
              'MINDSET',
              'CRAFT',
              'SPIRITUAL',
              'HABITS',
              'STRESS',
              'SLEEP',
              'DOPAMINE',
            ],
          },
        },
      },
    },
  },
};

type ExtractedInsight = {
  kind: CoachInsightKind;
  title: string;
  body: string;
  evidence: string;
  suggestedAction?: string;
  mediaSlot?: string;
  mediaTopic?: string;
};

interface ContextBundle {
  habitsProfile: HabitsProfile | null;
  recentCheckins: unknown[];
  recentJournal: unknown[];
  activeGoals: unknown[];
  weekReflections: unknown[];
  hoursByGoalThisWeek: Array<{ goalId: string; minutes: number }>;
  scheduleBlocks: Array<
    Pick<
      ScheduleBlock,
      | 'id'
      | 'title'
      | 'dayOfWeek'
      | 'startTime'
      | 'endTime'
      | 'category'
      | 'isRecurring'
      | 'goalId'
    >
  >;
  acceptedInsights: CoachInsight[];
  weekKey: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_BLOCK_CAP = 800;

const ACTIVE_INSIGHT_STATUSES: CoachInsightStatus[] = ['ACCEPTED', 'DOING'];

const MEDIA_SLOTS = new Set([
  'BREAKFAST',
  'LUNCH',
  'EVENING',
  'BEDTIME',
  'ANY',
]);
const MEDIA_TOPICS = new Set([
  'MINDSET',
  'CRAFT',
  'SPIRITUAL',
  'HABITS',
  'STRESS',
  'SLEEP',
  'DOPAMINE',
]);
const KIND_VALUES = new Set<CoachInsightKind>([
  'OBSERVATION',
  'SUGGESTION',
  'EXPERIMENT',
  'MEDIA_PROMPT',
]);

@Injectable()
export class CoachAiService {
  private readonly logger = new Logger(CoachAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly llmFactory: LlmFactory,
  ) {}

  // ----- Public read endpoints -----

  async getLatestNarrative(userId: string, scopeKey: string) {
    const conv = await this.prisma.coachConversation.findUnique({
      where: {
        userId_scope_scopeKey: { userId, scope: CoachScope.NARRATIVE, scopeKey },
      },
    });
    if (!conv) {
      throw new HttpException('No narrative cached', HttpStatus.NOT_FOUND);
    }
    const msg = await this.prisma.coachMessage.findFirst({
      where: {
        conversationId: conv.id,
        role: { in: [CoachRole.SYSTEM_NARRATIVE, CoachRole.ASSISTANT] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!msg) {
      throw new HttpException('No narrative cached', HttpStatus.NOT_FOUND);
    }
    return msg;
  }

  async getChatHistory(userId: string, scopeKey: string) {
    const conv = await this.prisma.coachConversation.findUnique({
      where: {
        userId_scope_scopeKey: { userId, scope: CoachScope.CHAT, scopeKey },
      },
    });
    if (!conv) return { messages: [] };
    const messages = await this.prisma.coachMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });
    return { messages };
  }

  /**
   * Wipe the chat conversation for a single scope so the next message starts
   * clean. Narrative messages + accepted insights are NOT touched — the
   * Coach still remembers what the user committed to. Only the chat thread
   * row + its messages are removed (cascade delete via Prisma relation).
   */
  async clearChat(userId: string, scopeKey: string): Promise<void> {
    await this.prisma.coachConversation.deleteMany({
      where: { userId, scope: CoachScope.CHAT, scopeKey },
    });
  }

  // ----- Streaming entry points -----

  /**
   * Stream the weekly narrative. If a cached narrative exists and `force`
   * is false, emit it as a single chunk + done without invoking the provider.
   * After a successful (live) stream, fire an async insight-extraction call
   * in the background — the SSE response has already closed by then.
   */
  async *streamNarrative(
    userId: string,
    scopeKey: string,
    force: boolean,
  ): AsyncGenerator<{ delta: string; done: boolean; error?: string }> {
    const byok = await this.loadByokOr412(userId);
    await this.assertWithinBudget(byok);

    const conversation = await this.findOrCreateConversation(
      userId,
      CoachScope.NARRATIVE,
      scopeKey,
    );

    if (!force) {
      const cached = await this.prisma.coachMessage.findFirst({
        where: {
          conversationId: conversation.id,
          role: { in: [CoachRole.SYSTEM_NARRATIVE, CoachRole.ASSISTANT] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (cached) {
        this.logger.log(
          `narrative cache hit scope=${scopeKey} user=${userId}`,
        );
        yield { delta: cached.content, done: false };
        yield { delta: '', done: true };
        return;
      }
    }

    const context = await this.buildContextBundle(userId, scopeKey);
    const messages = this.buildNarrativeMessages(context);

    // SECURITY: capture decrypted key into a local variable BEFORE opening the
    // stream so a concurrent DELETE cannot pull it out from under us.
    const decryptedKey = this.encryption.decrypt({
      ciphertext: Buffer.from(byok.ciphertext),
      iv: Buffer.from(byok.iv),
      authTag: Buffer.from(byok.authTag),
      keyVersion: byok.keyVersion,
    });

    // Result ref the runAndPersist generator fills in so we can fire the
    // extraction call after the stream closes.
    const result: { messageId?: string; fullText: string } = { fullText: '' };

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: byok.provider,
      decryptedKey,
      messages,
      persistRole: CoachRole.SYSTEM_NARRATIVE,
      scopeKey,
      result,
    });

    // Only extract when there is an actual narrative AND we persisted it.
    if (result.fullText.length > 0 && result.messageId) {
      this.extractInsightsAsync({
        userId,
        scopeKey,
        conversationId: conversation.id,
        narrativeMessageId: result.messageId,
        narrativeText: result.fullText,
        provider: byok.provider,
        decryptedKey,
        contextBundle: context,
      }).catch((err) =>
        this.logger.warn(
          `insight extraction failed user=${userId} scope=${scopeKey}: ${err?.message ?? err}`,
        ),
      );
    }
  }

  /**
   * Stream a chat reply. Persists the USER message BEFORE opening the stream
   * (retry safety) so a network blip during streaming doesn't drop the user's
   * input on the floor. Does NOT trigger insight extraction.
   */
  async *streamChatReply(
    userId: string,
    scopeKey: string,
    userContent: string,
  ): AsyncGenerator<{ delta: string; done: boolean; error?: string }> {
    const byok = await this.loadByokOr412(userId);
    await this.assertWithinBudget(byok);

    const conversation = await this.findOrCreateConversation(
      userId,
      CoachScope.CHAT,
      scopeKey,
    );

    // Persist USER message FIRST — retry safety.
    await this.prisma.coachMessage.create({
      data: {
        conversationId: conversation.id,
        role: CoachRole.USER,
        content: userContent,
      },
    });

    const history = await this.prisma.coachMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });

    const context = await this.buildContextBundle(userId, scopeKey);
    const messages = this.buildChatMessages(context, history);

    const decryptedKey = this.encryption.decrypt({
      ciphertext: Buffer.from(byok.ciphertext),
      iv: Buffer.from(byok.iv),
      authTag: Buffer.from(byok.authTag),
      keyVersion: byok.keyVersion,
    });

    const result: { messageId?: string; fullText: string } = { fullText: '' };

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: byok.provider,
      decryptedKey,
      messages,
      persistRole: CoachRole.ASSISTANT,
      scopeKey,
      result,
    });
    // NOTE: chat does NOT trigger extraction.
  }

  // ----- Shared internals -----

  private async *runAndPersist(args: {
    userId: string;
    conversationId: string;
    provider: import('@prisma/client').CoachProvider;
    decryptedKey: string;
    messages: LlmChatMessage[];
    persistRole: CoachRole;
    scopeKey: string;
    result: { messageId?: string; fullText: string };
  }): AsyncGenerator<{ delta: string; done: boolean; error?: string }> {
    const provider = this.llmFactory.create(args.provider, args.decryptedKey);
    const model = this.llmFactory.defaultModel(args.provider);

    let fullText = '';
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    try {
      const stream = provider.streamCompletion(args.messages, model);
      for await (const chunk of stream as AsyncIterable<LlmStreamChunk>) {
        if (chunk.delta) fullText += chunk.delta;
        if (chunk.done) {
          usage = chunk.usage;
          break;
        } else {
          yield { delta: chunk.delta, done: false };
        }
      }
    } catch (err: any) {
      // SECURITY: do not leak the decrypted key. Only the high-level message.
      const message =
        err?.message && typeof err.message === 'string'
          ? err.message
          : 'LLM provider error';
      this.logger.warn(
        `LLM stream error scope=${args.scopeKey} user=${args.userId}: ${message}`,
      );
      yield { delta: '', done: true, error: message };
      return;
    }

    args.result.fullText = fullText;

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    try {
      const [createdMsg] = await this.prisma.$transaction([
        this.prisma.coachMessage.create({
          data: {
            conversationId: args.conversationId,
            role: args.persistRole,
            content: fullText,
            promptTokens,
            completionTokens,
            model,
          },
        }),
        this.prisma.encryptedByokKey.update({
          where: { userId: args.userId },
          data: {
            tokensUsedThisMonth: { increment: totalTokens },
            lastValidatedAt: new Date(),
          },
        }),
      ]);

      args.result.messageId = (createdMsg as { id: string }).id;

      this.logger.log(
        `coach stream done scope=${args.scopeKey} user=${args.userId} ` +
          `prompt=${promptTokens} completion=${completionTokens} model=${model}`,
      );
    } catch (err: any) {
      this.logger.error(
        `failed to persist coach message scope=${args.scopeKey} user=${args.userId}: ${err?.message ?? err}`,
      );
      // Still close the SSE cleanly even if persistence fails.
    }

    yield { delta: '', done: true };
  }

  private async loadByokOr412(userId: string) {
    const byok = await this.prisma.encryptedByokKey.findUnique({
      where: { userId },
    });
    if (!byok) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PRECONDITION_FAILED,
          message: 'BYOK key not configured',
          error: 'PreconditionFailed',
        },
        HttpStatus.PRECONDITION_FAILED,
      );
    }
    return byok;
  }

  private async assertWithinBudget(byok: {
    userId: string;
    tokensUsedThisMonth: number;
    tokensLimit: number;
    tokensWindowStart: Date;
  }) {
    const now = Date.now();
    const windowAgeMs = now - byok.tokensWindowStart.getTime();
    if (windowAgeMs > THIRTY_DAYS_MS) {
      // Reset window and re-read.
      const reset = await this.prisma.encryptedByokKey.update({
        where: { userId: byok.userId },
        data: {
          tokensUsedThisMonth: 0,
          tokensWindowStart: new Date(now),
        },
      });
      byok.tokensUsedThisMonth = reset.tokensUsedThisMonth;
      byok.tokensWindowStart = reset.tokensWindowStart;
    }

    if (byok.tokensUsedThisMonth >= byok.tokensLimit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Monthly token budget exceeded',
          error: 'TooManyRequests',
          tokensUsed: byok.tokensUsedThisMonth,
          tokensLimit: byok.tokensLimit,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async findOrCreateConversation(
    userId: string,
    scope: CoachScope,
    scopeKey: string,
  ) {
    const existing = await this.prisma.coachConversation.findUnique({
      where: { userId_scope_scopeKey: { userId, scope, scopeKey } },
    });
    if (existing) return existing;
    try {
      return await this.prisma.coachConversation.create({
        data: { userId, scope, scopeKey },
      });
    } catch (err) {
      // Race: another concurrent request just created it. Re-read.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await this.prisma.coachConversation.findUnique({
          where: { userId_scope_scopeKey: { userId, scope, scopeKey } },
        });
        if (row) return row;
      }
      throw err;
    }
  }

  // ----- Context assembly -----

  private async buildContextBundle(
    userId: string,
    scopeKey: string,
  ): Promise<ContextBundle> {
    const habitsProfile = await this.prisma.habitsProfile.findUnique({
      where: { userId },
    });

    const recentCheckins = await this.prisma.dailyCheckin.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 7,
    });

    const recentJournalRaw = await this.prisma.journalEntry.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 14,
    });
    const recentJournal = recentJournalRaw.map((j) => ({
      date: j.date,
      mood: j.mood,
      energy: j.energy,
      content: capText(stripHtml(j.content), 500),
    }));

    const activeGoals = await this.prisma.goal.findMany({
      where: { userId, status: 'ACTIVE' as any },
      select: {
        id: true,
        title: true,
        deadline: true,
        loggedHours: true,
        status: true,
      },
    });

    const weekReflections = await this.prisma.goalReflection.findMany({
      where: { userId, weekKey: scopeKey },
    });

    const { from, to } = isoWeekRange(scopeKey);
    const hoursByGoalThisWeek = await this.aggregateHoursByGoal(
      userId,
      from,
      to,
    );

    const scheduleBlocksRaw = await this.prisma.scheduleBlock.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        category: true,
        isRecurring: true,
        goalId: true,
      },
    });

    const acceptedInsights = await this.prisma.coachInsight.findMany({
      where: { userId, status: { in: ACTIVE_INSIGHT_STATUSES } },
      orderBy: [{ startedDoingAt: 'desc' }, { acceptedAt: 'desc' }],
      take: 20,
    });

    return {
      habitsProfile,
      recentCheckins,
      recentJournal,
      activeGoals,
      weekReflections,
      hoursByGoalThisWeek,
      scheduleBlocks: scheduleBlocksRaw,
      acceptedInsights,
      weekKey: scopeKey,
    };
  }

  private async aggregateHoursByGoal(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ goalId: string; minutes: number }>> {
    const rows = await this.prisma.timeEntry.groupBy({
      by: ['goalId'],
      where: {
        userId,
        date: { gte: from, lte: to },
        goalId: { not: null },
      },
      _sum: { duration: true },
    });
    return rows
      .filter((r) => r.goalId !== null)
      .map((r) => ({
        goalId: r.goalId as string,
        minutes: r._sum.duration ?? 0,
      }));
  }

  // ----- Prompt rendering -----

  private buildNarrativeMessages(ctx: ContextBundle): LlmChatMessage[] {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContextMessage(ctx, 'narrative') },
    ];
  }

  private buildChatMessages(
    ctx: ContextBundle,
    history: Array<{ role: CoachRole; content: string }>,
  ): LlmChatMessage[] {
    const messages: LlmChatMessage[] = [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: buildUserContextMessage(ctx, 'chat') },
      // The user-context message above plays the role of "Context" the chat
      // system prompt references; subsequent turns are the chat itself.
    ];
    for (const m of history) {
      if (m.role === CoachRole.USER) {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === CoachRole.ASSISTANT) {
        messages.push({ role: 'assistant', content: m.content });
      }
      // SYSTEM_NARRATIVE messages are intentionally omitted from chat history.
    }
    return messages;
  }

  // ----- Insight extraction -----

  private async extractInsightsAsync(args: {
    userId: string;
    scopeKey: string;
    conversationId: string;
    narrativeMessageId: string;
    narrativeText: string;
    provider: import('@prisma/client').CoachProvider;
    decryptedKey: string;
    contextBundle: ContextBundle;
  }): Promise<void> {
    try {
      const provider = this.llmFactory.create(
        args.provider,
        args.decryptedKey,
      );
      const model = this.llmFactory.defaultModel(args.provider);

      const contextJson = JSON.stringify(
        serializeContextForExtraction(args.contextBundle),
      );
      const userMessage = `CONTEXT:\n${contextJson}\n\nNARRATIVE:\n${args.narrativeText}`;

      const messages: LlmChatMessage[] = [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ];

      const { data, usage } = await provider.extractStructured<{
        insights?: unknown;
      }>({
        messages,
        model,
        schemaName: 'extract_coach_insights',
        schema: INSIGHT_SCHEMA,
      });

      const rawInsights = Array.isArray((data as any)?.insights)
        ? ((data as any).insights as unknown[])
        : [];

      const validated: ExtractedInsight[] = [];
      for (const raw of rawInsights) {
        const item = validateInsight(raw);
        if (item) validated.push(item);
      }

      // Dedupe against currently-active insight titles via normalized Levenshtein
      // similarity.
      const activeTitles = args.contextBundle.acceptedInsights.map((i) =>
        i.title.toLowerCase(),
      );
      const survivors = validated.filter((item) => {
        const t = item.title.toLowerCase();
        for (const existing of activeTitles) {
          if (normalizedSimilarity(t, existing) > 0.85) return false;
        }
        return true;
      });

      const totalTokens =
        (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);

      if (survivors.length === 0) {
        // Still count the tokens even when nothing survives.
        await this.prisma.encryptedByokKey.update({
          where: { userId: args.userId },
          data: { tokensUsedThisMonth: { increment: totalTokens } },
        });
        this.logger.log(
          `insight extraction produced 0 survivors user=${args.userId} scope=${args.scopeKey} prompt=${usage.promptTokens} completion=${usage.completionTokens} model=${model}`,
        );
        return;
      }

      const inserts = survivors.map((item) =>
        this.prisma.coachInsight.create({
          data: {
            userId: args.userId,
            sourceConversationId: args.conversationId,
            sourceMessageId: args.narrativeMessageId,
            scopeKey: args.scopeKey,
            kind: item.kind,
            title: item.title,
            body: item.body,
            evidence: item.evidence,
            suggestedAction: item.suggestedAction ?? null,
            mediaSlot:
              item.kind === 'MEDIA_PROMPT' ? item.mediaSlot ?? null : null,
            mediaTopic:
              item.kind === 'MEDIA_PROMPT' ? item.mediaTopic ?? null : null,
          },
        }),
      );

      await this.prisma.$transaction([
        ...inserts,
        this.prisma.encryptedByokKey.update({
          where: { userId: args.userId },
          data: { tokensUsedThisMonth: { increment: totalTokens } },
        }),
      ]);

      this.logger.log(
        `insight extraction persisted=${survivors.length} dropped=${validated.length - survivors.length} user=${args.userId} scope=${args.scopeKey} prompt=${usage.promptTokens} completion=${usage.completionTokens} model=${model}`,
      );
    } catch (err: any) {
      // NEVER rethrow — narrative is already saved and SSE closed.
      this.logger.warn(
        `extractInsightsAsync threw user=${args.userId} scope=${args.scopeKey}: ${err?.message ?? err}`,
      );
    }
  }
}

// ===== Pure helpers (exported for tests, but kept module-local) =====

/**
 * Strip HTML tags without pulling in a parser library.
 */
export function stripHtml(s: string): string {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Convert an ISO week scopeKey ("2026-W22") into a [from, to] Date range
 * covering Monday 00:00:00 through Sunday 23:59:59.999 UTC. If parsing
 * fails, defaults to the current week.
 */
export function isoWeekRange(scopeKey: string): { from: Date; to: Date } {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(scopeKey);
  if (!m) {
    return currentIsoWeekRange();
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const from = new Date(week1Monday);
  from.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const to = new Date(from);
  to.setUTCDate(from.getUTCDate() + 7);
  to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
  return { from, to };
}

function currentIsoWeekRange(): { from: Date; to: Date } {
  const now = new Date();
  const dow = now.getUTCDay() || 7;
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  from.setUTCDate(from.getUTCDate() - (dow - 1));
  const to = new Date(from);
  to.setUTCDate(from.getUTCDate() + 7);
  to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
  return { from, to };
}

// ----- Memory + prompt construction helpers -----

function weeksAgoLabel(when: Date | null | undefined, now: Date = new Date()): string {
  if (!when) return 'recently';
  const ms = now.getTime() - when.getTime();
  const weeks = Math.max(0, Math.round(ms / (7 * 24 * 60 * 60 * 1000)));
  if (weeks <= 0) return 'this week';
  if (weeks === 1) return 'last week';
  return `${weeks} weeks ago`;
}

export function formatMemoryBlock(
  insights: CoachInsight[],
  cap: number = MEMORY_BLOCK_CAP,
  now: Date = new Date(),
): string {
  // Sort by acceptedAt desc as the canonical "freshest first" order. We then
  // FIFO-trim by dropping the OLDEST first if we exceed the cap. To do that
  // we build oldest-first, then drop from the front until it fits.
  const sortedOldestFirst = [...insights].sort((a, b) => {
    const aT = (a.acceptedAt ?? a.createdAt).getTime();
    const bT = (b.acceptedAt ?? b.createdAt).getTime();
    return aT - bT;
  });

  const lines: string[] = sortedOldestFirst.map((i) => {
    const ago = weeksAgoLabel(i.acceptedAt ?? i.createdAt, now);
    const action = i.suggestedAction ? `: ${i.suggestedAction}` : '';
    return `[ACCEPTED ${ago}, status=${i.status}] ${i.title}${action}`;
  });

  // FIFO trim: drop oldest until total length <= cap.
  while (lines.length > 0 && lines.join('\n').length > cap) {
    lines.shift();
  }

  // Reverse so freshest appears first (more useful to the model).
  return lines.reverse().join('\n');
}

function buildUserContextMessage(
  ctx: ContextBundle,
  mode: 'narrative' | 'chat',
): string {
  const h = ctx.habitsProfile;
  const religiousContext =
    (h?.religiousContext as ReligiousContext | undefined) ??
    ReligiousContext.NONE;

  const opLines: string[] = [];
  opLines.push(`why: ${h?.why?.trim() ? h.why.trim() : '(not set)'}`);
  opLines.push(`religiousContext: ${religiousContext}`);
  if (religiousContext !== ReligiousContext.NONE) {
    const notes = (h?.spiritualNotes ?? '').trim();
    opLines.push(`spiritualNotes: ${notes.length ? notes : '(none)'}`);
  }
  opLines.push(
    `sleepTarget: ${h?.sleepTargetHours ?? 8}h, bedtime ${h?.bedtime ?? '23:00'}, wake ${h?.wakeTime ?? '07:00'}`,
  );
  opLines.push(
    `work env: ${h?.workEnvironment?.trim() ? h.workEnvironment.trim() : '(unspecified)'}`,
  );

  const memory = formatMemoryBlock(ctx.acceptedInsights);
  const memorySection = memory.length ? memory : '(none yet)';

  // The "rest of bundle" sent as JSON — exclude habitsProfile (already
  // formatted in Operator profile) and acceptedInsights (formatted as
  // memory) to keep the payload smaller and avoid duplication.
  const rest = {
    weekKey: ctx.weekKey,
    recentCheckins: ctx.recentCheckins,
    recentJournal: ctx.recentJournal,
    activeGoals: ctx.activeGoals,
    weekReflections: ctx.weekReflections,
    hoursByGoalThisWeek: ctx.hoursByGoalThisWeek,
    scheduleBlocks: ctx.scheduleBlocks,
  };

  const intro =
    mode === 'narrative'
      ? "Write this week's narrative for me. Reference specific data points. Close with one Socratic question."
      : 'Reply to my next message using the context below.';

  return [
    intro,
    '',
    '## Operator profile',
    opLines.join('\n'),
    '',
    "## What you've already suggested (and the user accepted)",
    memorySection,
    '',
    "## This week's context",
    JSON.stringify(rest),
  ].join('\n');
}

function serializeContextForExtraction(ctx: ContextBundle) {
  // Smaller subset to feed the extraction call — it only needs to know
  // what the narrative was based on plus the Operator profile.
  const h = ctx.habitsProfile;
  return {
    weekKey: ctx.weekKey,
    operator: h
      ? {
          why: h.why,
          religiousContext: h.religiousContext,
          spiritualNotes: h.spiritualNotes,
          sleepTargetHours: h.sleepTargetHours,
          bedtime: h.bedtime,
          wakeTime: h.wakeTime,
          workEnvironment: h.workEnvironment,
        }
      : null,
    activeGoals: ctx.activeGoals,
    weekReflections: ctx.weekReflections,
    hoursByGoalThisWeek: ctx.hoursByGoalThisWeek,
    recentCheckins: ctx.recentCheckins,
    recentJournal: ctx.recentJournal,
    scheduleBlocks: ctx.scheduleBlocks,
    acceptedInsightTitles: ctx.acceptedInsights.map((i) => i.title),
  };
}

// ----- Validation -----

function validateInsight(raw: unknown): ExtractedInsight | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !KIND_VALUES.has(kind as CoachInsightKind)) {
    return null;
  }
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  const evidence = typeof r.evidence === 'string' ? r.evidence.trim() : '';
  if (!title || title.length > 100) return null;
  if (!body || body.length > 600) return null;
  if (!evidence || evidence.length > 300) return null;

  const suggestedAction =
    typeof r.suggestedAction === 'string'
      ? r.suggestedAction.trim()
      : undefined;
  if (suggestedAction && suggestedAction.length > 200) return null;

  let mediaSlot: string | undefined;
  let mediaTopic: string | undefined;
  if (kind === 'MEDIA_PROMPT') {
    mediaSlot = typeof r.mediaSlot === 'string' ? r.mediaSlot : undefined;
    mediaTopic = typeof r.mediaTopic === 'string' ? r.mediaTopic : undefined;
    if (!mediaSlot || !MEDIA_SLOTS.has(mediaSlot)) return null;
    if (!mediaTopic || !MEDIA_TOPICS.has(mediaTopic)) return null;
  }

  return {
    kind: kind as CoachInsightKind,
    title,
    body,
    evidence,
    suggestedAction: suggestedAction || undefined,
    mediaSlot,
    mediaTopic,
  };
}

// ----- Levenshtein for dedupe -----

export function normalizedSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const d = levenshtein(a, b);
  return 1 - d / maxLen;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Two-row DP.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
