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
}
