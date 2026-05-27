import Anthropic from '@anthropic-ai/sdk';
import {
  CoachLlmProvider,
  LlmChatMessage,
  LlmStreamChunk,
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
        const u = (event as any).message?.usage;
        if (u) {
          promptTokens = u.input_tokens ?? 0;
          completionTokens = u.output_tokens ?? 0;
        }
      } else if (event.type === 'content_block_delta') {
        const delta = (event as any).delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (delta.text.length > 0) {
            yield { delta: delta.text, done: false };
          }
        }
      } else if (event.type === 'message_delta') {
        const u = (event as any).usage;
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
}
