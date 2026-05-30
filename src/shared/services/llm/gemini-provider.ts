import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  CoachLlmProvider,
  LlmChatMessage,
  LlmStreamChunk,
  LlmUsage,
} from './llm.interface';

/**
 * Google Gemini provider.
 *
 * Two shape differences from the OpenAI SDK that this adapter handles:
 *
 * 1. Gemini takes the system prompt as a separate `systemInstruction`
 *    parameter on the model itself, not as the first message in the
 *    conversation. We split it out here so callers pass us the same
 *    `[system, user, assistant, …]` array they pass every other provider.
 *
 * 2. Gemini's role for the assistant is `'model'`, not `'assistant'`,
 *    and it does not accept a `system` role inside the history. We map
 *    the OpenAI-style roles to Gemini-style before sending.
 *
 * Usage tokens: Gemini's streaming API surfaces `usageMetadata` on the
 * final aggregated response, which we extract after the loop completes.
 */
export class GeminiProvider implements CoachLlmProvider {
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  private splitSystem(messages: LlmChatMessage[]): {
    systemInstruction: string | undefined;
    history: { role: 'user' | 'model'; parts: { text: string }[] }[];
  } {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemInstruction =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join('\n\n')
        : undefined;
    const history = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
        parts: [{ text: m.content }],
      }));
    return { systemInstruction, history };
  }

  async *streamCompletion(
    messages: LlmChatMessage[],
    model: string,
  ): AsyncIterable<LlmStreamChunk> {
    const { systemInstruction, history } = this.splitSystem(messages);
    const m = this.client.getGenerativeModel({
      model,
      ...(systemInstruction ? { systemInstruction } : {}),
    });
    const stream = await m.generateContentStream({
      contents: history,
    });

    for await (const chunk of stream.stream) {
      const delta = chunk.text();
      if (delta && delta.length > 0) {
        yield { delta, done: false };
      }
    }

    // Final aggregated response carries usageMetadata. Await it AFTER
    // the stream is fully drained — accessing earlier returns nothing.
    const final = await stream.response;
    const usageMeta: any = (final as any).usageMetadata;
    const usage: LlmUsage | undefined = usageMeta
      ? {
          promptTokens: usageMeta.promptTokenCount ?? 0,
          completionTokens: usageMeta.candidatesTokenCount ?? 0,
        }
      : undefined;

    yield { delta: '', done: true, usage };
  }

  async extractStructured<T = unknown>(args: {
    messages: LlmChatMessage[];
    model: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<{ data: T; usage: LlmUsage }> {
    const { systemInstruction, history } = this.splitSystem(args.messages);
    const m = this.client.getGenerativeModel({
      model: args.model,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        // Gemini supports JSON-mode via responseMimeType + responseSchema.
        // The schema shape is mostly compatible with JSON-Schema; the SDK
        // will reject some advanced keywords (oneOf etc.), so callers
        // should keep schemas to the basic types/properties/required set.
        responseMimeType: 'application/json',
        responseSchema: args.schema as any,
        temperature: 0.2,
      },
    });

    const result = await m.generateContent({ contents: history });
    const text = result.response.text();
    const usageMeta: any = (result.response as any).usageMetadata;
    const usage: LlmUsage = {
      promptTokens: usageMeta?.promptTokenCount ?? 0,
      completionTokens: usageMeta?.candidatesTokenCount ?? 0,
    };
    return { data: JSON.parse(text) as T, usage };
  }
}
