import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CoachInsight,
  CoachInsightKind,
  CoachInsightStatus,
  CoachRole,
  CoachScope,
  GoalStatus,
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
import {
  injectionGuardPrompt,
  newUntrustedNonce,
  sanitizeDeep,
  sanitizeSingleLine,
  sanitizeUntrusted,
  wrapUntrusted,
} from './safety/prompt-safety';
import {
  CHAT_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  INSIGHT_SCHEMA,
  SYSTEM_PROMPT,
} from './coach-ai.prompts';

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
  // Individual time entries from the last ~14 days, with IDs, so the
  // model can target a specific entry when emitting an
  // UPDATE_TIME_ENTRY / DELETE_TIME_ENTRY proposal (previously the
  // model only had aggregated totals and refused to edit because it
  // couldn't identify which entry to touch).
  recentTimeEntries: Array<{
    id: string;
    date: string;
    duration: number;
    taskName: string;
    taskId: string | null;
    goalId: string | null;
    goalTitle: string | null;
    notes: string | null;
  }>;
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
  /**
   * The user's OWN Notes page titles, most-recently-updated first, capped at
   * NOTE_TITLE_CAP. Titles ONLY — never `content`.
   *
   * This exists so the model can target a REAL page when it emits
   * APPEND_NOTE_CONTENT. Before it existed, the prompt explicitly told the
   * model it would never see note titles and to synthesise a `titleHint` from
   * the user's phrasing — while the only titles it could actually see were
   * goals, schedule blocks, time-entry task names and insight titles. So
   * "add customize to my tech to learn notes" came back as a confident
   * proposal against the GOAL "Tech Podcast Listening" and then failed at
   * apply time inside NotesService.appendContentByTitleHint. No amount of
   * fuzzier title matching can recover from being handed the name of a
   * different object of a different type; the model has to be able to see
   * the real list.
   *
   * Chat mode only (see buildContextBundle's `includeNoteTitles`): the
   * narrative never emits APPEND_NOTE_CONTENT, so fetching or rendering
   * these there would be pure token and DB waste. Empty array otherwise.
   */
  noteTitles: string[];
  weekKey: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Truncate to the start of the UTC calendar day. Used as the unique
 * key on SharedCoachUsage so the per-user daily quota resets at
 * 00:00 UTC regardless of where the user is in the world. Keeps the
 * quota predictable and matches when most free LLM provider tiers
 * reset (Google, OpenRouter, Groq all reset on a UTC boundary).
 */
function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/**
 * Turn a raw LLM-provider exception into a short, user-facing sentence.
 * The raw text is logged separately; this is what the user reads in-chat, so
 * it must never leak keys/URLs and should say what to do next. Rate-limit
 * (Gemini RESOURCE_EXHAUSTED / HTTP 429) is the common one on large multi-step
 * requests, so it gets its own actionable message.
 */
function humanizeLlmError(err: unknown, raw: string): string {
  const errObj = err as { status?: unknown; code?: unknown } | null | undefined;
  const status =
    (typeof errObj?.status === 'number' && errObj.status) ||
    (typeof errObj?.code === 'number' && errObj.code) ||
    undefined;
  const code = typeof errObj?.code === 'string' ? errObj.code : '';
  const text = `${code} ${raw}`.toLowerCase();

  const isRateLimited =
    status === 429 ||
    code === 'RESOURCE_EXHAUSTED' ||
    /\b429\b|too many requests|resource has been exhausted|rate limit|rate-limit|quota/.test(
      text,
    );
  if (isRateLimited) {
    return 'The AI is getting more requests than the provider allows right now. Wait a few seconds and try again. Large multi-step changes are the most likely to hit this, so breaking the request into smaller pieces usually helps.';
  }

  const isAuth =
    status === 401 ||
    status === 403 ||
    /api key|api_key|unauthenticated|permission denied|invalid.*key/.test(text);
  if (isAuth) {
    return 'The AI provider rejected the request. If you are using your own API key, reconnect it in Settings, Integrations.';
  }

  const isTimeout =
    status === 504 ||
    /timeout|timed out|deadline exceeded|econnreset|network/.test(text);
  if (isTimeout) {
    return 'The AI provider took too long to respond. Please try again.';
  }

  return 'The AI provider had an error while responding. Please try again in a moment.';
}
const MEMORY_BLOCK_CAP = 800;

/**
 * Ceilings on how much stored content may enter a single prompt.
 *
 * Two reasons these exist. Cost: on the operator's shared key the only limit
 * used to be a daily message count, so one account with a very large schedule
 * or very long check-ins could make each of those messages arbitrarily
 * expensive. Blast radius: every one of these fields is user-authored free
 * text, and a smaller surface is a smaller place to hide injected instructions.
 *
 * All are set well above what a normal, fully-used account produces.
 */
const CHECKIN_FIELD_CAP = 500;
const REFLECTION_CAP = 40;
const REFLECTION_FIELD_CAP = 500;
const SCHEDULE_BLOCK_CAP = 300;
/**
 * How many Notes page titles reach the CHAT prompt (never the narrative one).
 *
 * Deliberately modest, because this list is added prompt cost on every chat
 * turn and there is a concurrent effort to shrink Coach context spend. The
 * account this was diagnosed on holds ~10 pages; 50 leaves five times that
 * headroom while bounding the worst case at roughly 400 prompt tokens
 * (~7 tokens per `  - "Title"` row, plus heading and fence markers).
 *
 * Ordered `updatedAt desc` so that when an account DOES exceed the cap, what
 * falls off is the coldest pages — the ones a live conversation is least
 * likely to be about. A truncated list is still strictly better than no list:
 * the model is told this section is the complete and only source of note
 * targets, so a page it cannot see produces a "which page did you mean?"
 * question rather than a confident wrong guess.
 */
const NOTE_TITLE_CAP = 50;
/**
 * Per-title character cap for the rendered rows. Mirrors
 * AppendNoteContentDto's `@MaxLength(200)` on `titleHint`, minus one so that
 * sanitizeSingleLine's truncation ellipsis still leaves the row at or under
 * 200 characters: anything the model can legally copy out of this list is a
 * payload the DTO will accept.
 */
const NOTE_TITLE_CHAR_CAP = 199;
/** Hard ceiling on the serialized JSON blob at the end of the context message. */
const CONTEXT_JSON_CAP = 120_000;

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
        userId_scope_scopeKey: {
          userId,
          scope: CoachScope.NARRATIVE,
          scopeKey,
        },
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

  /**
   * Delete the given chat message AND every later message in the same
   * conversation. Used when the user edits an old USER message: the edit
   * replaces that turn, so everything after it (the original assistant reply
   * + any subsequent back-and-forth) becomes stale. Removing it keeps the
   * LLM context lean and prevents the Coach from contradicting itself.
   *
   * Ownership: validated by checking the message's conversation belongs to
   * the user and matches scope+scopeKey.
   */
  async truncateChatFrom(
    userId: string,
    scopeKey: string,
    messageId: string,
  ): Promise<{ deleted: number }> {
    const message = await this.prisma.coachMessage.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (
      !message ||
      message.conversation.userId !== userId ||
      message.conversation.scope !== CoachScope.CHAT ||
      message.conversation.scopeKey !== scopeKey
    ) {
      throw new HttpException('Message not found', HttpStatus.NOT_FOUND);
    }
    const result = await this.prisma.coachMessage.deleteMany({
      where: {
        conversationId: message.conversationId,
        createdAt: { gte: message.createdAt },
      },
    });
    return { deleted: result.count };
  }

  /**
   * Turn an ASSISTANT chat reply into a tracked CoachInsight (status ACCEPTED
   * so it shows up in the user’s reminders immediately). User-driven: they
   * read the reply and decided this is worth keeping. Ownership check goes
   * through the conversation row.
   */
  async saveChatMessageAsInsight(
    userId: string,
    scopeKey: string,
    messageId: string,
    titleOverride?: string,
  ) {
    const message = await this.prisma.coachMessage.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (
      !message ||
      message.conversation.userId !== userId ||
      message.conversation.scope !== CoachScope.CHAT ||
      message.conversation.scopeKey !== scopeKey
    ) {
      throw new HttpException('Message not found', HttpStatus.NOT_FOUND);
    }
    if (message.role !== CoachRole.ASSISTANT) {
      throw new HttpException(
        'Only Coach replies can be saved as reminders.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const trimmed = (message.content ?? '').trim();
    const fallbackTitle = (() => {
      const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
      return firstSentence.length > 80
        ? firstSentence.slice(0, 77) + '...'
        : firstSentence;
    })();
    const title =
      (titleOverride ?? fallbackTitle).slice(0, 100) || 'Saved from chat';
    const body = trimmed.length > 600 ? trimmed.slice(0, 597) + '...' : trimmed;

    const insight = await this.prisma.coachInsight.create({
      data: {
        userId,
        scopeKey,
        sourceConversationId: message.conversationId,
        sourceMessageId: message.id,
        kind: 'SUGGESTION',
        title,
        body,
        evidence: 'Saved from a Coach chat reply.',
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });

    return insight;
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
    const resolved = await this.resolveCoachKey(userId);
    if (resolved.kind === 'byok') {
      await this.assertWithinBudget(resolved.byok);
    } else {
      await this.reserveSharedQuotaSlot(userId);
    }

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
        this.logger.log(`narrative cache hit scope=${scopeKey} user=${userId}`);
        yield { delta: cached.content, done: false };
        yield { delta: '', done: true };
        return;
      }
    }

    const context = await this.buildContextBundle(userId, scopeKey);
    const messages = this.buildNarrativeMessages(context);

    // SECURITY: capture decrypted key into a local variable BEFORE opening the
    // stream so a concurrent DELETE cannot pull it out from under us.
    const decryptedKey =
      resolved.kind === 'byok'
        ? this.encryption.decrypt({
            ciphertext: Buffer.from(resolved.byok.ciphertext),
            iv: Buffer.from(resolved.byok.iv),
            authTag: Buffer.from(resolved.byok.authTag),
            keyVersion: resolved.byok.keyVersion,
          })
        : resolved.decryptedKey;
    const activeProvider =
      resolved.kind === 'byok' ? resolved.byok.provider : resolved.provider;
    const activeSelectedModel =
      resolved.kind === 'byok'
        ? resolved.byok.selectedModel
        : resolved.selectedModel;

    const result: { messageId?: string; fullText: string } = { fullText: '' };

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: activeProvider,
      decryptedKey,
      messages,
      persistRole: CoachRole.SYSTEM_NARRATIVE,
      scopeKey,
      result,
      selectedModel: activeSelectedModel,
      isShared: resolved.kind === 'shared',
    });

    if (result.fullText.length > 0 && result.messageId) {
      this.extractInsightsAsync({
        userId,
        scopeKey,
        conversationId: conversation.id,
        narrativeMessageId: result.messageId,
        narrativeText: result.fullText,
        provider: activeProvider,
        decryptedKey,
        contextBundle: context,
        selectedModel: activeSelectedModel,
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
    const resolved = await this.resolveCoachKey(userId);
    if (resolved.kind === 'byok') {
      await this.assertWithinBudget(resolved.byok);
    } else {
      await this.reserveSharedQuotaSlot(userId);
    }

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

    const context = await this.buildContextBundle(userId, scopeKey, {
      includeNoteTitles: true,
    });
    const messages = this.buildChatMessages(context, history);

    const decryptedKey =
      resolved.kind === 'byok'
        ? this.encryption.decrypt({
            ciphertext: Buffer.from(resolved.byok.ciphertext),
            iv: Buffer.from(resolved.byok.iv),
            authTag: Buffer.from(resolved.byok.authTag),
            keyVersion: resolved.byok.keyVersion,
          })
        : resolved.decryptedKey;
    const activeProvider =
      resolved.kind === 'byok' ? resolved.byok.provider : resolved.provider;
    const activeSelectedModel =
      resolved.kind === 'byok'
        ? resolved.byok.selectedModel
        : resolved.selectedModel;

    const result: { messageId?: string; fullText: string } = { fullText: '' };

    yield* this.runAndPersist({
      userId,
      conversationId: conversation.id,
      provider: activeProvider,
      decryptedKey,
      messages,
      persistRole: CoachRole.ASSISTANT,
      scopeKey,
      result,
      selectedModel: activeSelectedModel,
      isShared: resolved.kind === 'shared',
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
    selectedModel?: string | null;
    /** True when running against the operator's shared Gemini key
     *  instead of a user-owned BYOK row. Token counts are NOT charged
     *  to a non-existent BYOK row; daily message count is incremented
     *  on the user's SharedCoachUsage row instead. */
    isShared?: boolean;
  }): AsyncGenerator<{ delta: string; done: boolean; error?: string }> {
    const provider = this.llmFactory.create(args.provider, args.decryptedKey);
    const model = this.llmFactory.resolveModel(
      args.provider,
      args.selectedModel,
    );

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
    } catch (err) {
      // SECURITY: never surface the raw provider error to the client — it can
      // carry the key, internal URLs, or noisy stack text. Log the raw message,
      // send the user a clean, actionable one.
      const raw =
        err?.message && typeof err.message === 'string'
          ? err.message
          : 'LLM provider error';
      this.logger.warn(
        `LLM stream error scope=${args.scopeKey} user=${args.userId}: ${raw}`,
      );
      // The shared-key slot was reserved before the call. The provider gave us
      // nothing, so hand it back rather than charging the user for an outage.
      if (args.isShared) await this.releaseSharedQuotaSlot(args.userId);
      yield { delta: '', done: true, error: humanizeLlmError(err, raw) };
      return;
    }

    args.result.fullText = fullText;

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    try {
      const ops: Prisma.PrismaPromise<unknown>[] = [
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
      ];
      if (args.isShared) {
        // Nothing to charge here any more. The shared-key daily counter is
        // incremented by reserveSharedQuotaSlot() BEFORE the provider call, so
        // that the check and the increment are one atomic statement and
        // concurrent streams cannot all pass a stale read. Incrementing again
        // on the way out would double-count.
      } else {
        ops.push(
          this.prisma.encryptedByokKey.update({
            where: { userId: args.userId },
            data: {
              tokensUsedThisMonth: { increment: totalTokens },
              lastValidatedAt: new Date(),
            },
          }),
        );
      }
      const [createdMsg] = await this.prisma.$transaction(ops);

      args.result.messageId = (createdMsg as { id: string }).id;

      this.logger.log(
        `coach stream done scope=${args.scopeKey} user=${args.userId} ` +
          `prompt=${promptTokens} completion=${completionTokens} model=${model}` +
          (args.isShared ? ' (shared)' : ''),
      );
    } catch (err) {
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

  /**
   * Resolve which key/provider this user's next Coach call should use.
   *
   * Preference order:
   *   1. The user's own BYOK row (best — uses their quota, their model
   *      choice, their billing).
   *   2. The operator's shared Gemini Flash key from
   *      GOOGLE_AI_SHARED_API_KEY, gated by a per-user daily message
   *      count so one user can't drain the shared free tier for
   *      everyone else. Lets brand-new users try the Coach without
   *      signing up for any AI provider first.
   *
   * Throws PRECONDITION_FAILED only when both are unavailable (no
   * BYOK AND no shared key configured on the server).
   *
   * Public: also called directly by CoachVoiceIntentService, which needs the
   * same BYOK-or-shared-key resolution for its fast classification call but
   * deliberately does NOT go through assertWithinBudget / reserveSharedQuotaSlot
   * below — see the long comment on CoachVoiceIntentService for why sharing
   * those counters with a call meant to fire on nearly every voice utterance
   * would be wrong.
   */
  async resolveCoachKey(userId: string): Promise<
    | { kind: 'byok'; byok: import('@prisma/client').EncryptedByokKey }
    | {
        kind: 'shared';
        provider: import('@prisma/client').CoachProvider;
        decryptedKey: string;
        selectedModel: string;
      }
  > {
    const byok = await this.prisma.encryptedByokKey.findUnique({
      where: { userId },
    });
    if (byok) return { kind: 'byok', byok };

    const sharedKey = process.env.GOOGLE_AI_SHARED_API_KEY;
    if (sharedKey && sharedKey.length > 0) {
      return {
        kind: 'shared',
        provider: 'GEMINI',
        decryptedKey: sharedKey,
        selectedModel: 'gemini-2.5-flash',
      };
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.PRECONDITION_FAILED,
        message: 'BYOK key not configured',
        error: 'PreconditionFailed',
      },
      HttpStatus.PRECONDITION_FAILED,
    );
  }

  /**
   * Reserve one slot against the per-user daily cap on shared-key Coach calls,
   * atomically, BEFORE the provider is called. Reads SHARED_COACH_DAILY_LIMIT
   * at call time (default 20). Throws 429 when the user is already at the cap.
   *
   * This used to be a read-then-write: `assertSharedQuota` read the counter and
   * the increment happened in `runAndPersist` only after the stream finished.
   * Two things were wrong with that. Concurrent requests all read the same
   * pre-increment value and all passed the check, so N parallel SSE streams
   * cost N times the quota and charged one; and because the increment came
   * after a successful stream, a user could spend the operator's shared key
   * without the counter ever moving.
   *
   * The fix is to make the check and the increment the same statement. `upsert`
   * with `increment` compiles to a single atomic INSERT ... ON CONFLICT DO
   * UPDATE, so concurrent callers serialise on the unique (userId, day) index
   * and each gets a distinct post-increment count back. Whoever gets a count
   * above the limit is the one refused, and hands the slot straight back.
   */
  private async reserveSharedQuotaSlot(userId: string): Promise<void> {
    const limit = parseInt(process.env.SHARED_COACH_DAILY_LIMIT ?? '20', 10);
    const day = startOfUtcDay(new Date());

    const row = await this.prisma.sharedCoachUsage.upsert({
      where: { userId_day: { userId, day } },
      update: { messageCount: { increment: 1 } },
      create: { userId, day, messageCount: 1 },
    });

    if (row.messageCount > limit) {
      // Over the line: give the slot back so the counter reflects reality and
      // repeated refused attempts don't inflate it without bound.
      await this.releaseSharedQuotaSlot(userId, day);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'Shared Coach daily limit reached. Add your own free Gemini or OpenRouter key in Settings to keep going.',
          error: 'TooManyRequests',
          shared: true,
          messagesUsedToday: limit,
          dailyLimit: limit,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Hand a reserved slot back. Used when the request is refused for being over
   * quota, and when the provider call fails before producing anything, so a
   * provider outage does not silently eat the user's daily allowance.
   */
  private async releaseSharedQuotaSlot(
    userId: string,
    day: Date = startOfUtcDay(new Date()),
  ): Promise<void> {
    try {
      await this.prisma.sharedCoachUsage.update({
        where: { userId_day: { userId, day } },
        data: { messageCount: { decrement: 1 } },
      });
    } catch (err) {
      // Best effort. Losing a refund costs the user one message off today's
      // allowance; failing the request over it would be worse.
      this.logger.warn(
        `failed to release shared quota slot user=${userId}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Read-only summary the BYOK state endpoint returns to the web app
   * so the Coach UI can show a "shared usage X of Y today" meter
   * before the user even sends a message.
   */
  async getSharedUsageSummary(userId: string): Promise<{
    available: boolean;
    used: number;
    limit: number;
  }> {
    const sharedKey = process.env.GOOGLE_AI_SHARED_API_KEY;
    if (!sharedKey || sharedKey.length === 0) {
      return { available: false, used: 0, limit: 0 };
    }
    const limit = parseInt(process.env.SHARED_COACH_DAILY_LIMIT ?? '20', 10);
    const day = startOfUtcDay(new Date());
    const usage = await this.prisma.sharedCoachUsage.findUnique({
      where: { userId_day: { userId, day } },
    });
    return {
      available: true,
      used: usage?.messageCount ?? 0,
      limit,
    };
  }

  /**
   * Resolve the caller's key AND take the same quota gates the streaming entry
   * points take, for a one-shot metered call made from another module.
   *
   * WHY THIS EXISTS RATHER THAN THE CALLER DOING IT. `assertWithinBudget` and
   * `reserveSharedQuotaSlot` are private, and must stay private: the shared
   * one is only correct because its check and its increment are a single
   * atomic upsert (see its comment — the read-then-write version it replaced
   * let N concurrent streams all pass a stale read and charge for one). A
   * second module reimplementing that would reintroduce exactly that bug, out
   * of sight of the comment explaining it. So the gate is exported as a whole
   * operation, in the right order, with the release path attached.
   *
   * DELIBERATELY NOT the exemption CoachVoiceIntentService takes. That service
   * skips these gates on purpose, because it fires on nearly every utterance
   * and a per-utterance call sharing the daily MESSAGE counter would drain a
   * week of chat allowance in minutes. Note summarization is the opposite of
   * that on every axis — rare, very large input, expensive — so it is exactly
   * what these counters exist to meter, and it goes through them.
   *
   * `release()` hands a reserved shared slot back. Call it when the provider
   * call fails before producing anything, so an outage does not silently eat
   * the user's daily allowance. It is a no-op for BYOK callers (nothing was
   * reserved) and safe to call more than once only in the sense that each call
   * decrements, so call it exactly once, on the failure path.
   */
  async beginMeteredCall(userId: string): Promise<{
    resolved: Awaited<ReturnType<CoachAiService['resolveCoachKey']>>;
    release: () => Promise<void>;
  }> {
    const resolved = await this.resolveCoachKey(userId);
    if (resolved.kind === 'byok') {
      await this.assertWithinBudget(resolved.byok);
      return { resolved, release: async () => undefined };
    }
    await this.reserveSharedQuotaSlot(userId);
    return {
      resolved,
      release: () => this.releaseSharedQuotaSlot(userId),
    };
  }

  /**
   * Charge a completed one-shot metered call's tokens against a BYOK user's
   * monthly budget, mirroring what `runAndPersist` does at the end of a stream.
   *
   * Shared-key callers are intentionally a no-op: that counter is per MESSAGE,
   * not per token, and it was already incremented by `beginMeteredCall` before
   * the provider ran — incrementing again here would double-count, which is the
   * same reasoning `runAndPersist` spells out at its own `isShared` branch.
   *
   * Best-effort by design. The work the user asked for has already succeeded by
   * the time this runs; failing their request because the meter could not be
   * updated would trade a real result for a bookkeeping error.
   */
  async chargeMeteredUsage(
    userId: string,
    resolvedKind: 'byok' | 'shared',
    totalTokens: number,
  ): Promise<void> {
    if (resolvedKind === 'shared' || totalTokens <= 0) return;
    try {
      await this.prisma.encryptedByokKey.update({
        where: { userId },
        data: {
          tokensUsedThisMonth: { increment: totalTokens },
          lastValidatedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `failed to charge metered usage user=${userId}: ${err?.message ?? err}`,
      );
    }
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
    // Notes page titles are fetched for the CHAT path only — the narrative
    // path has no action that can target a note, so both the query and the
    // prompt section it feeds are skipped there. Defaults to off so a new
    // call site cannot start paying for them by accident.
    options: { includeNoteTitles: boolean } = { includeNoteTitles: false },
  ): Promise<ContextBundle> {
    const { from, to } = isoWeekRange(scopeKey);
    // Last ~14 days of individual time entries with IDs so the model
    // can emit precise UPDATE/DELETE proposals. Goals are inner-joined
    // for the title — saves the model a lookup when it explains the
    // proposal to the user.
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    // These nine reads are independent — none of them consumes another's
    // result, they were just written one `await` after another, which forces
    // the DB round trips to happen in series. Running them concurrently
    // fetches the exact same rows, just without paying for eight extra
    // network round trips back-to-back on the critical path of every single
    // Coach turn (narrative AND chat both call this).
    const [
      habitsProfile,
      recentCheckinRows,
      recentJournalRaw,
      activeGoals,
      weekReflectionRows,
      hoursByGoalThisWeek,
      recentTimeEntriesRaw,
      scheduleBlocksRaw,
      acceptedInsights,
      noteRows,
    ] = await Promise.all([
      this.prisma.habitsProfile.findUnique({ where: { userId } }),

      // Explicit `select` rather than the whole row. `findMany` with no
      // select shipped id, userId, and the createdAt/updatedAt/submittedAt
      // timestamps to a third-party LLM on every call. None of it helps the
      // coach reason, and the internal ids are the sort of thing that should
      // not leave the system for no reason. The free-text fields are capped
      // for the same reason the journal is: one enormous check-in should not
      // be able to crowd out the rest of the prompt, or the operator's
      // shared-key spend.
      this.prisma.dailyCheckin.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
        take: 7,
        select: {
          date: true,
          mood: true,
          energy: true,
          focus: true,
          blocked: true,
          worked: true,
        },
      }),

      this.prisma.journalEntry.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
        take: 14,
      }),

      this.prisma.goal.findMany({
        where: { userId, status: GoalStatus.ACTIVE },
        select: {
          id: true,
          title: true,
          deadline: true,
          loggedHours: true,
          status: true,
        },
      }),

      this.prisma.goalReflection.findMany({
        where: { userId, weekKey: scopeKey },
        take: REFLECTION_CAP,
        select: {
          goalId: true,
          weekKey: true,
          feel: true,
          worked: true,
          blocked: true,
          nextWeekFocus: true,
        },
      }),

      this.aggregateHoursByGoal(userId, from, to),

      this.prisma.timeEntry.findMany({
        where: { userId, date: { gte: fourteenDaysAgo } },
        orderBy: { date: 'desc' },
        take: 80,
        select: {
          id: true,
          date: true,
          duration: true,
          taskName: true,
          taskId: true,
          goalId: true,
          notes: true,
          goal: { select: { title: true } },
        },
      }),

      // `take` added: this query had no bound at all, so prompt size (and,
      // on the operator's shared key, prompt cost) scaled with however many
      // blocks the account happened to hold. An account with thousands of
      // blocks could drive an enormous single request. A full 7-day
      // schedule is well under this ceiling.
      this.prisma.scheduleBlock.findMany({
        where: { userId },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        take: SCHEDULE_BLOCK_CAP,
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
      }),

      this.prisma.coachInsight.findMany({
        where: { userId, status: { in: ACTIVE_INSIGHT_STATUSES } },
        orderBy: [{ startedDoingAt: 'desc' }, { acceptedAt: 'desc' }],
        take: 20,
      }),

      // Titles ONLY. `content` is deliberately not selected: note bodies are
      // long, private, and would be by far the largest untrusted region in the
      // prompt. The model never needs a body — it only has to echo a title back
      // as APPEND_NOTE_CONTENT's `titleHint`.
      //
      // `where: { userId }` matches NotesService.appendContentByTitleHint's own
      // candidate scope exactly (owner-only — NOT the shared-note path in
      // findOneAccessible). Listing a title the apply step cannot reach would
      // only move the failure later.
      //
      // Sits inside the same Promise.all as the other reads rather than after
      // it: this is the chat path's own critical path, so serialising it would
      // hand back the round trip the parallelisation above just saved. Resolves
      // to [] on the narrative path without touching the DB at all.
      options.includeNoteTitles
        ? this.prisma.note.findMany({
            where: { userId },
            orderBy: { updatedAt: 'desc' },
            take: NOTE_TITLE_CAP,
            select: { title: true },
          })
        : Promise.resolve([] as { title: string }[]),
    ]);

    const noteTitles = noteRows.map((n) => n.title);

    const recentCheckins = recentCheckinRows.map((c) => ({
      ...c,
      blocked: capText(c.blocked, CHECKIN_FIELD_CAP),
      worked: capText(c.worked, CHECKIN_FIELD_CAP),
    }));

    const recentJournal = recentJournalRaw.map((j) => ({
      date: j.date,
      mood: j.mood,
      energy: j.energy,
      content: capText(stripHtml(j.content), 500),
    }));

    const weekReflections = weekReflectionRows.map((r) => ({
      ...r,
      worked: capText(r.worked, REFLECTION_FIELD_CAP),
      blocked: capText(r.blocked, REFLECTION_FIELD_CAP),
      nextWeekFocus: capText(r.nextWeekFocus, REFLECTION_FIELD_CAP),
    }));

    const recentTimeEntries = recentTimeEntriesRaw.map((e) => ({
      id: e.id,
      date: e.date.toISOString().slice(0, 10),
      duration: e.duration,
      taskName: e.taskName,
      taskId: e.taskId,
      goalId: e.goalId,
      goalTitle: e.goal?.title ?? null,
      notes: e.notes,
    }));

    return {
      habitsProfile,
      recentCheckins,
      recentJournal,
      activeGoals,
      weekReflections,
      hoursByGoalThisWeek,
      recentTimeEntries,
      scheduleBlocks: scheduleBlocksRaw,
      acceptedInsights,
      noteTitles,
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

  /**
   * A fresh nonce per request. The untrusted-data markers in the context
   * message carry it, and the system prompt tells the model that only markers
   * bearing this id close a region, so stored user content cannot write its own
   * END marker and escape into the instruction channel.
   */
  private buildNarrativeMessages(ctx: ContextBundle): LlmChatMessage[] {
    const nonce = newUntrustedNonce();
    return [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}\n\n${injectionGuardPrompt()}`,
      },
      {
        role: 'user',
        content: buildUserContextMessage(ctx, 'narrative', nonce),
      },
    ];
  }

  private buildChatMessages(
    ctx: ContextBundle,
    history: Array<{ role: CoachRole; content: string }>,
  ): LlmChatMessage[] {
    const nonce = newUntrustedNonce();
    const messages: LlmChatMessage[] = [
      {
        role: 'system',
        content: `${CHAT_SYSTEM_PROMPT}\n\n${injectionGuardPrompt()}`,
      },
      { role: 'user', content: buildUserContextMessage(ctx, 'chat', nonce) },
      // The user-context message above plays the role of "Context" the chat
      // system prompt references; subsequent turns are the chat itself.
    ];
    for (const m of history) {
      if (m.role === CoachRole.USER) {
        // The user's own turns ARE the legitimate instruction channel, so they
        // are not fenced as untrusted data. The one thing defanged is the
        // `coach-proposal` fence token: users paste whole schedules in here
        // from elsewhere, and a pasted fence that the model echoes would be
        // parsed by the client as a real approval card.
        messages.push({ role: 'user', content: sanitizeUntrusted(m.content) });
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
    selectedModel?: string | null;
  }): Promise<void> {
    try {
      const provider = this.llmFactory.create(args.provider, args.decryptedKey);
      const model = this.llmFactory.resolveModel(
        args.provider,
        args.selectedModel,
      );

      // The extraction call reads the same user-authored content as the
      // narrative, so it gets the same boundary. Its output is schema-bound
      // and lands as CoachInsight rows rather than actions, but a poisoned
      // insight is still text the user is shown and that replays into the
      // memory block of every later prompt.
      const nonce = newUntrustedNonce();
      const contextJson = JSON.stringify(
        sanitizeDeep(serializeContextForExtraction(args.contextBundle)),
      );
      const userMessage = [
        'CONTEXT:',
        wrapUntrusted(nonce, contextJson),
        '',
        'NARRATIVE:',
        args.narrativeText,
      ].join('\n');

      const messages: LlmChatMessage[] = [
        {
          role: 'system',
          content: `${EXTRACTION_SYSTEM_PROMPT}\n\n${injectionGuardPrompt()}`,
        },
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

      const rawInsights = Array.isArray(data?.insights)
        ? (data.insights as unknown[])
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
              item.kind === 'MEDIA_PROMPT' ? (item.mediaSlot ?? null) : null,
            mediaTopic:
              item.kind === 'MEDIA_PROMPT' ? (item.mediaTopic ?? null) : null,
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
    } catch (err) {
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
 * Convert a scopeKey into a [from, to] Date range. Supports four shapes:
 *   "YYYY-Www"  ISO week, Monday 00:00 through Sunday 23:59:59.999 UTC
 *   "YYYY-Mmm"  Calendar month, day 1 through last day 23:59:59.999 UTC
 *   "YYYY-Qq"   Quarter (q in 1..4), 3-month span UTC
 *   "YYYY"      Full calendar year UTC
 * If parsing fails, defaults to the current ISO week. Function name kept
 * for back-compat with existing callers.
 */
export function isoWeekRange(scopeKey: string): { from: Date; to: Date } {
  // Year
  let m: RegExpExecArray | null = /^(\d{4})$/.exec(scopeKey);
  if (m) {
    const y = Number(m[1]);
    const from = new Date(Date.UTC(y, 0, 1));
    const to = new Date(Date.UTC(y + 1, 0, 1));
    to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
    return { from, to };
  }
  // Quarter
  m = /^(\d{4})-Q([1-4])$/.exec(scopeKey);
  if (m) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const startMonth = (q - 1) * 3;
    const from = new Date(Date.UTC(y, startMonth, 1));
    const to = new Date(Date.UTC(y, startMonth + 3, 1));
    to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
    return { from, to };
  }
  // Month
  m = /^(\d{4})-M(\d{2})$/.exec(scopeKey);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const from = new Date(Date.UTC(y, mo, 1));
    const to = new Date(Date.UTC(y, mo + 1, 1));
    to.setUTCMilliseconds(to.getUTCMilliseconds() - 1);
    return { from, to };
  }
  // Week (default)
  m = /^(\d{4})-W(\d{1,2})$/.exec(scopeKey);
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

function weeksAgoLabel(
  when: Date | null | undefined,
  now: Date = new Date(),
): string {
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

  // Only `title` (100 chars, tightly constrained) is replayed here.
  // `suggestedAction` and `body` are both excluded: they're longer-form free
  // text an earlier, manipulated Coach turn could have used to inject
  // instructions, which would otherwise come back as trusted-looking
  // "things you already agreed to" context in a later, unrelated session.
  const lines: string[] = sortedOldestFirst.map((i) => {
    const ago = weeksAgoLabel(i.acceptedAt ?? i.createdAt, now);
    return `[ACCEPTED ${ago}, status=${i.status}] ${i.title}`;
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
  nonce: string,
): string {
  const h = ctx.habitsProfile;
  const religiousContext =
    (h?.religiousContext as ReligiousContext | undefined) ??
    ReligiousContext.NONE;

  // Every value below is user-authored free text. `why` and `spiritualNotes`
  // in particular are long-form fields the user controls completely, so they
  // are the most attractive place to park an injection. Sanitised here and
  // fenced as untrusted data at the bottom of this function.
  const opLines: string[] = [];
  const why = sanitizeUntrusted(h?.why ?? '').trim();
  opLines.push(`why: ${why.length ? why : '(not set)'}`);
  opLines.push(`religiousContext: ${religiousContext}`);
  if (religiousContext !== ReligiousContext.NONE) {
    const notes = sanitizeUntrusted(h?.spiritualNotes ?? '').trim();
    opLines.push(`spiritualNotes: ${notes.length ? notes : '(none)'}`);
  }
  opLines.push(
    `sleepTarget: ${h?.sleepTargetHours ?? 8}h, bedtime ${sanitizeSingleLine(h?.bedtime ?? '23:00', 20)}, wake ${sanitizeSingleLine(h?.wakeTime ?? '07:00', 20)}`,
  );
  const workEnv = sanitizeSingleLine(h?.workEnvironment ?? '');
  opLines.push(`work env: ${workEnv.length ? workEnv : '(unspecified)'}`);

  // Insight titles were written by the model but are stored, editable, and
  // replayed into a later prompt, so they are untrusted on the way back in.
  const memory = sanitizeUntrusted(formatMemoryBlock(ctx.acceptedInsights));
  const memorySection = memory.length ? memory : '(none yet)';

  // The "rest of bundle" sent as JSON — exclude habitsProfile (already
  // formatted in Operator profile) and acceptedInsights (formatted as
  // memory) to keep the payload smaller and avoid duplication.
  //
  // scheduleBlocks is placed first (rather than last, its natural object-
  // literal position) and ALSO gets its own dedicated plain-text listing
  // below. capText hard-truncates this whole JSON blob at CONTEXT_JSON_CAP
  // chars for accounts with a lot of journal/time-entry history, and
  // schedule block ids are the thing every UPDATE/DELETE_SCHEDULE_BLOCK
  // proposal depends on being copied correctly — they should never be the
  // field silently cut off, or the last field an LLM has to eyeball out of
  // a JSON wall to find a UUID in.
  const rest = {
    weekKey: ctx.weekKey,
    scheduleBlocks: ctx.scheduleBlocks,
    recentCheckins: ctx.recentCheckins,
    recentJournal: ctx.recentJournal,
    activeGoals: ctx.activeGoals,
    weekReflections: ctx.weekReflections,
    hoursByGoalThisWeek: ctx.hoursByGoalThisWeek,
    recentTimeEntries: ctx.recentTimeEntries,
  };

  // Surface the full schedule + linkable goals as plain-text sections so the
  // model can copy an id verbatim off a short line instead of eyeballing a
  // UUID out of the JSON dump below (which is also hard-capped and can, for
  // an account with enough journal/time-entry history, truncate before it
  // ever reaches scheduleBlocks). A block that's only reachable through that
  // JSON blob is exactly the shape of a real bug: a plain "rename Work to
  // Work & Infra" ask emitted an id that didn't correspond to any block,
  // producing an empty, unrenderable proposal card and a 404 on apply. This
  // full listing is the fix — every block gets a reliable id=... line,
  // linked or not.
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmt12h = (t: string): string => {
    const [hStr, mStr] = (t || '').split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    if (Number.isNaN(h) || Number.isNaN(m)) return t;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const dh = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${dh}:${m.toString().padStart(2, '0')} ${ampm}`;
  };
  // Titles go through sanitizeSingleLine so a title containing a newline, a
  // `|`, or a quote cannot forge extra rows in these lists. A fabricated row
  // is how injected text would hand the model an id that isn't the user's.
  const scheduleLine = (b: ContextBundle['scheduleBlocks'][number]) =>
    `  - id=${b.id} | "${sanitizeSingleLine(b.title)}" | ${dayNames[b.dayOfWeek] ?? '?'} ${fmt12h(b.startTime)} to ${fmt12h(b.endTime)} | category=${sanitizeSingleLine(b.category ?? 'none', 40)} | goalId=${b.goalId ?? 'none'}`;
  const allBlocks = ctx.scheduleBlocks ?? [];
  const allBlocksSection = allBlocks.length
    ? allBlocks.map(scheduleLine).join('\n')
    : '  (no schedule blocks yet)';
  const unlinkedBlocks = allBlocks.filter((b) => !b.goalId);
  const unlinkedSection = unlinkedBlocks.length
    ? unlinkedBlocks.map(scheduleLine).join('\n')
    : '  (none, all blocks are linked to goals)';
  const goalsListSection = (ctx.activeGoals ?? []).length
    ? (ctx.activeGoals ?? [])
        .map(
          (g: { id: string; title: string }) =>
            `  - id=${g.id} | "${sanitizeSingleLine(g.title)}"`,
        )
        .join('\n')
    : '  (no active goals)';

  // Plain-text recent time entries — mirrors the unlinkedBlocks /
  // goalsList pattern so the model can grab IDs without parsing the
  // JSON dump. Capped at 30 lines (most recent first) to keep the
  // prompt size sane; the full 80 is still in the JSON blob below.
  const recentEntriesSection = (ctx.recentTimeEntries ?? []).length
    ? (ctx.recentTimeEntries ?? [])
        .slice(0, 30)
        .map((e) => {
          const goalTitle = sanitizeSingleLine(e.goalTitle);
          const taskName = sanitizeSingleLine(e.taskName);
          const goal = goalTitle ? `goal="${goalTitle}"` : 'goal=(none)';
          const task = taskName ? `"${taskName}"` : '(no task title)';
          return `  - id=${e.id} | ${e.date} | ${e.duration}m | ${task} | ${goal}`;
        })
        .join('\n')
    : '  (no time entries in the last 14 days)';

  // The user's Notes page titles. This is the ONLY place the model ever sees
  // a note target, and it is chat-only: the narrative prompt has no action
  // that can touch a note, so it stays byte-identical to before.
  //
  // Titles are user-authored free text exactly like goal and block titles, so
  // they go through sanitizeSingleLine (which strips control characters,
  // collapses newlines, and neutralises `|` and `"`) and land inside the same
  // nonce-fenced untrusted region as every other stored value. A title
  // containing a newline must not be able to forge an extra row here, because
  // a forged row is a page name the model would believe in.
  //
  // Deliberately NO `id=` prefix, unlike every other list in this message.
  // AppendNoteContentDto has no id field at all (see its class doc), so there
  // is nothing to copy — and the visibly different row shape is a structural
  // cue that these are a different KIND of thing from the goal and block ids
  // above. That is the point: the bug being fixed here was the model reaching
  // into the GOALS list for a note target.
  const noteTitleRows = (ctx.noteTitles ?? []).map((t) =>
    sanitizeSingleLine(t, NOTE_TITLE_CHAR_CAP),
  );
  // Two pages whose rendered rows are identical cannot be told apart by the
  // model OR by matchNotesByTitle, which returns 'ambiguous' and fails the
  // apply. Say so on the row instead of letting the user find out on Apply.
  const dupeCounts = new Map<string, number>();
  for (const t of noteTitleRows) {
    const key = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length === 0) continue;
    dupeCounts.set(key, (dupeCounts.get(key) ?? 0) + 1);
  }
  const notesListSection = noteTitleRows.length
    ? noteTitleRows
        .map((t) => {
          if (t.length === 0) {
            return '  - (untitled page — cannot be targeted by name)';
          }
          const key = t.trim().toLowerCase().replace(/\s+/g, ' ');
          if ((dupeCounts.get(key) ?? 0) > 1) {
            return `  - "${t}"  (WARNING: more than one page has this title, appending by name will fail — ask the user to rename one)`;
          }
          if (t.endsWith('…')) {
            return `  - "${t}"  (WARNING: title too long to target by name — ask the user to shorten it)`;
          }
          return `  - "${t}"`;
        })
        .join('\n')
    : '  (this user has no note pages at all)';

  const intro =
    mode === 'narrative'
      ? "Write this week's narrative for me. Reference specific data points. Close with one Socratic question."
      : 'Reply to my next message using the context below.';

  // Section HEADINGS stay outside the markers — they are the operator's
  // instructions and the model must keep following them. Only the stored data
  // under each heading is fenced. Mixing the two would mean telling the model
  // to ignore our own "use these IDs" guidance.
  const fence = (body: string) => wrapUntrusted(nonce, body);

  return [
    intro,
    '',
    '## Operator profile',
    fence(opLines.join('\n')),
    '',
    "## What you've already suggested (and the user accepted)",
    fence(memorySection),
    '',
    '## Full weekly schedule (id, title, day, time, category, goalId — use these ids verbatim for ANY schedule block action, never invent or guess one)',
    fence(allBlocksSection),
    '',
    '## UNLINKED schedule blocks (no goalId, user cannot log time against them)',
    fence(unlinkedSection),
    '',
    '## Active goals you can link blocks to',
    fence(goalsListSection),
    '',
    '## Recent time entries (use these IDs for UPDATE_TIME_ENTRY / DELETE_TIME_ENTRY proposals — never invent an id)',
    fence(recentEntriesSection),
    ...(mode === 'chat'
      ? [
          '',
          "## The user's Notes pages — the COMPLETE list, and the ONLY valid source of an APPEND_NOTE_CONTENT titleHint. NOT goals, NOT schedule blocks, NOT tasks. No ids: that action takes none. If the page the user named is not on this list, ASK which one they meant instead of proposing.",
          fence(notesListSection),
        ]
      : []),
    '',
    "## This week's context (full JSON)",
    fence(capText(JSON.stringify(sanitizeDeep(rest)), CONTEXT_JSON_CAP)),
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
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
