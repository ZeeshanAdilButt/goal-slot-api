import OpenAI from 'openai';
import {
  CoachLlmProvider,
  LlmChatMessage,
  LlmStreamChunk,
  LlmUsage,
} from './llm.interface';

/**
 * OpenAI chat-completions streaming provider.
 *
 * Uses `stream: true` with `stream_options: { include_usage: true }` so the
 * final SSE chunk from OpenAI carries a `usage` payload. That terminal chunk
 * has an empty `choices` array — we detect it and emit a single `done: true`
 * chunk with the usage. Earlier chunks emit `done: false` with content deltas.
 */
export class OpenAiProvider implements CoachLlmProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async *streamCompletion(
    messages: LlmChatMessage[],
    model: string,
  ): AsyncIterable<LlmStreamChunk> {
    const stream = await this.client.chat.completions.create({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;

    for await (const chunk of stream) {
      // OpenAI's terminal chunk (when include_usage=true) has choices=[] and
      // usage populated. Capture usage and continue — we'll emit the done
      // chunk after the loop completes.
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
        sawUsage = true;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { delta, done: false };
      }
    }

    yield {
      delta: '',
      done: true,
      usage: sawUsage ? { promptTokens, completionTokens } : undefined,
    };
  }

  async extractStructured<T = unknown>(args: {
    messages: LlmChatMessage[];
    model: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<{ data: T; usage: LlmUsage }> {
    const completion = await this.client.chat.completions.create({
      model: args.model,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: args.schemaName,
          strict: true,
          schema: args.schema as any,
        },
      } as any,
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const raw = completion.choices[0]?.message?.content ?? '{}';
    const usage: LlmUsage = {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    };
    return { data: JSON.parse(raw) as T, usage };
  }
}
