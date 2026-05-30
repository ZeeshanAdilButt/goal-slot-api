import OpenAI from 'openai';
import {
  CoachLlmProvider,
  LlmChatMessage,
  LlmStreamChunk,
  LlmUsage,
} from './llm.interface';

/**
 * OpenRouter provider.
 *
 * OpenRouter exposes an OpenAI-compatible REST surface, so we reuse the
 * `openai` SDK with `baseURL` swapped to OpenRouter's endpoint. This gives
 * us access to OpenRouter's full model catalogue including the `:free`
 * variants of Llama 3.3 70B, DeepSeek, Mistral, Gemini Flash passthrough,
 * etc. without writing a second adapter.
 *
 * The two custom headers (`HTTP-Referer` + `X-Title`) are OpenRouter's
 * recommended-but-optional attribution tags. We set them so usage in
 * OpenRouter's dashboard is identifiable as coming from GoalSlot rather
 * than an anonymous client.
 */
export class OpenRouterProvider implements CoachLlmProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://www.goalslot.io',
        'X-Title': 'GoalSlot Coach',
      },
    });
  }

  async *streamCompletion(
    messages: LlmChatMessage[],
    model: string,
  ): AsyncIterable<LlmStreamChunk> {
    const stream = await this.client.chat.completions.create({
      model,
      stream: true,
      // OpenRouter passes include_usage through to compatible models;
      // when the upstream model doesn't report usage we just emit a
      // terminal chunk with no usage payload.
      stream_options: { include_usage: true },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;

    for await (const chunk of stream) {
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
    // OpenRouter supports OpenAI's `response_format` on models that
    // expose JSON-mode upstream (most modern ones do). Fall back to
    // plain text + JSON.parse if the model refuses the format flag.
    try {
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
    } catch (e) {
      // Plain-text fallback — works for models that ignore response_format.
      const completion = await this.client.chat.completions.create({
        model: args.model,
        temperature: 0.2,
        messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      const raw = completion.choices[0]?.message?.content ?? '{}';
      const usage: LlmUsage = {
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
      };
      // Strip optional ```json fences before parsing
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      return { data: JSON.parse(cleaned) as T, usage };
    }
  }
}
