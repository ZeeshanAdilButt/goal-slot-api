import Anthropic from '@anthropic-ai/sdk';
import {
  CoachLlmProvider,
  LlmChatMessage,
  LlmStreamChunk,
  LlmUsage,
} from './llm.interface';

/**
 * Anthropic Messages streaming provider.
 *
 * Anthropic's API takes the system prompt as a separate field (not a message),
 * so we split it out. Content deltas arrive as `content_block_delta` events
 * with `delta.type === 'text_delta'`. The final `message_delta` event carries
 * `usage` with `input_tokens` and `output_tokens` — note that `input_tokens`
 * on `message_delta` is the prompt count from the initial `message_start`
 * event, so we track both and sum at close.
 */
export class AnthropicProvider implements CoachLlmProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *streamCompletion(
    messages: LlmChatMessage[],
    model: string,
  ): AsyncIterable<LlmStreamChunk> {
    const systemParts: string[] = [];
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        turns.push({ role: m.role, content: m.content });
      }
    }

    const stream = this.client.messages.stream({
      model,
      max_tokens: 1024,
      system: systemParts.join('\n\n') || undefined,
      messages: turns,
    });

    let promptTokens = 0;
    let completionTokens = 0;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        // `message_start` reports `usage.input_tokens` immediately.
        const u = event.message?.usage;
        if (u) {
          promptTokens = u.input_tokens ?? 0;
          completionTokens = u.output_tokens ?? 0;
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (delta.text.length > 0) {
            yield { delta: delta.text, done: false };
          }
        }
      } else if (event.type === 'message_delta') {
        // The SDK's MessageDeltaUsage type only declares `output_tokens`, but
        // the API has been observed to also send a cumulative `input_tokens`
        // here — kept as an optional extension rather than widening to `any`.
        const u = event.usage as
          | (Anthropic.MessageDeltaUsage & { input_tokens?: number })
          | undefined;
        if (u) {
          // message_delta usage carries the cumulative output_tokens.
          if (typeof u.output_tokens === 'number') {
            completionTokens = u.output_tokens;
          }
          if (typeof u.input_tokens === 'number' && u.input_tokens > 0) {
            promptTokens = u.input_tokens;
          }
        }
      }
    }

    yield {
      delta: '',
      done: true,
      usage: { promptTokens, completionTokens },
    };
  }

  async extractStructured<T = unknown>(args: {
    messages: LlmChatMessage[];
    model: string;
    schemaName: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<{ data: T; usage: LlmUsage }> {
    const systemParts: string[] = [];
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of args.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        turns.push({ role: m.role, content: m.content });
      }
    }

    const res = await this.client.messages.create({
      model: args.model,
      // The Anthropic SDK requires this, so unlike the other three providers
      // there is no "leave it unset" option — 1500 is the historical default
      // every caller got before `maxTokens` existed, kept so nothing changes
      // for them. See the interface for why a note summary must raise it.
      max_tokens: args.maxTokens ?? 1500,
      temperature: 0.2,
      system: systemParts.join('\n\n') || undefined,
      messages: turns,
      tools: [
        {
          name: args.schemaName,
          description: 'Return structured insights.',
          input_schema: args.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: args.schemaName },
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolUse) {
      throw new Error('Anthropic returned no tool_use block');
    }
    const usage: LlmUsage = {
      promptTokens: res.usage?.input_tokens ?? 0,
      completionTokens: res.usage?.output_tokens ?? 0,
    };
    return { data: toolUse.input as T, usage };
  }
}
