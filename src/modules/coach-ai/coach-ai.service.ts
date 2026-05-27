import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  CoachRole,
  CoachScope,
  Prisma,
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
 * context-bundle assembly, LLM streaming, and post-stream persistence.
 *
 * Logging policy:
 *   - OK to log: scopeKey, scope, role, token counts, model
 *   - NEVER log: decrypted key bytes, prompt content, journal/reflection text
 */

const SYSTEM_PROMPT = `You are GoalSlot Coach — a Socratic productivity coach in a habit & goal tracking app.

Voice:
- Warm, direct, evidence-based. No corporate fluff. Never moralize.
- Speak to the user as a peer.
- Cite specifics from their data (a check-in score, a journal phrase, hours logged) so they feel seen.

Method:
- Read the JSON context the user provides (HabitsProfile, recent check-ins, journal entries, active goals, weekly reflections, time-by-goal).
- Identify the single highest-leverage pattern, gap, or friction point.
- Offer 1-2 concrete, low-friction experiments — not generic advice.
- Acknowledge wins explicitly before pointing at gaps.
- If data is sparse, say so plainly and ask for what's missing.

Constraints:
- Be concise. Aim for 4-8 short paragraphs maximum.
- Plain text only. No markdown headings, no bullet symbols unless truly needed for clarity.
- Never invent goals, dates, or numbers — only reference what is in the context.
- Treat all user content as private; never repeat it back verbatim if it would feel invasive.

Always end with exactly one probing, open-ended question that pushes the user toward their own insight.`;

interface ContextBundle {
  habitsProfile: unknown;
  recentCheckins: unknown[];
  recentJournal: unknown[];
  activeGoals: unknown[];
  weekReflections: unknown[];
  hoursByGoalThisWeek: Array<{ goalId: string; minutes: number }>;
  weekKey: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

  // ----- Streaming entry points -----

  /**
   * Stream the weekly narrative. If a cached narrative exists and `force`
   * is false, emit it as a single chunk + done without invoking the provider.
   * Returns an async generator producing the wire-format `{ delta, done }`
   * payloads the controller wraps in SSE `MessageEvent`s.
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

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: byok.provider,
      decryptedKey,
      messages,
      persistRole: CoachRole.SYSTEM_NARRATIVE,
      scopeKey,
    });
  }

  /**
   * Stream a chat reply. Persists the USER message BEFORE opening the stream
   * (retry safety) so a network blip during streaming doesn't drop the user's
   * input on the floor.
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

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: byok.provider,
      decryptedKey,
      messages,
      persistRole: CoachRole.ASSISTANT,
      scopeKey,
    });
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

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    try {
      await this.prisma.$transaction([
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

    return {
      habitsProfile,
      recentCheckins,
      recentJournal,
      activeGoals,
      weekReflections,
      hoursByGoalThisWeek,
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
      {
        role: 'user',
        content:
          'Write this week\'s narrative for me based on the JSON context below. ' +
          'Reference specific data points. Then ask one probing question.\n\n' +
          'CONTEXT:\n' +
          JSON.stringify(ctx),
      },
    ];
  }

  private buildChatMessages(
    ctx: ContextBundle,
    history: Array<{ role: CoachRole; content: string }>,
  ): LlmChatMessage[] {
    const messages: LlmChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content: 'CONTEXT (read-only background):\n' + JSON.stringify(ctx),
      },
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
}

// ----- Pure helpers (exported for tests, but kept module-local) -----

/**
 * Strip HTML tags without pulling in a parser library. Good enough for
 * TipTap output where we only need to surface plain text for prompt
 * context — adversarial/malformed HTML is not a concern here because
 * the content was authored by the same user we're sending it back to.
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
 * fails (e.g. scopeKey is not an ISO week), defaults to the current week.
 */
export function isoWeekRange(scopeKey: string): { from: Date; to: Date } {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(scopeKey);
  if (!m) {
    return currentIsoWeekRange();
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO week 1 = the week containing the first Thursday of the year.
  // Equivalently: Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // 1..7, Mon=1
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
