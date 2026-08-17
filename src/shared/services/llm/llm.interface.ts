/**
 * Provider-agnostic LLM streaming abstraction used by the Coach AI module.
 *
 * All concrete providers (OpenAI, Anthropic) implement `CoachLlmProvider` and
 * yield a unified stream of `LlmStreamChunk` objects so the service layer
 * does not need to special-case vendor SDKs.
 */

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmChatMessage {
  role: LlmRole;
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmStreamChunk {
  /** Text delta. Empty string on the terminal (done) chunk. */
  delta: string;
  /** True only on the terminal chunk. `usage` is attached on this chunk. */
  done: boolean;
  /** Present on the terminal chunk when the provider reports token counts. */
  usage?: LlmUsage;
}

export interface CoachLlmProvider {
  streamCompletion(
    messages: LlmChatMessage[],
    model: string,
  ): AsyncIterable<LlmStreamChunk>;

  /**
   * One-shot, non-streaming structured-output call. The provider is asked to
   * produce JSON matching `schema` and we return the parsed object plus usage.
   *
   * - OpenAI: uses `response_format: { type: 'json_schema', strict: true }`.
   * - Anthropic: uses tool_use with `tool_choice` forcing the tool by name.
   *
   * Implementations MUST NOT log the raw model output or the messages.
   */
  extractStructured<T = unknown>(args: {
    messages: LlmChatMessage[];
    model: string;
    schemaName: string;
    schema: Record<string, unknown>;
    /**
     * Ceiling on the response length, in tokens. Optional, and every provider
     * keeps its previous behaviour when it is omitted — so no existing caller
     * changes.
     *
     * It exists because the Anthropic SDK REQUIRES `max_tokens` on every
     * request, so that provider had to hardcode one (1500). That is ample for
     * the insight-extraction call this interface was written for, and far too
     * small for a note summary: ~1500 tokens is roughly 6 KB of HTML including
     * tags, which a structured summary of a two-hour lecture blows straight
     * through. Anthropic stops mid-token when it hits the cap, so the result is
     * not a short summary — it is a truncated one, cut off mid-tag, which the
     * summary sanitiser then rejects for being unbalanced. The other three
     * providers set no cap at all and only need to honour this when asked.
     */
    maxTokens?: number;
  }): Promise<{ data: T; usage: LlmUsage }>;
}
