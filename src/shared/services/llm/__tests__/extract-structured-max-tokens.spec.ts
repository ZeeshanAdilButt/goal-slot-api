import { AnthropicProvider } from '../anthropic-provider';
import { GeminiProvider } from '../gemini-provider';
import { OpenAiProvider } from '../openai-provider';
import { OpenRouterProvider } from '../openrouter-provider';
import { LlmChatMessage } from '../llm.interface';

/**
 * `extractStructured`'s optional `maxTokens`, across all four providers.
 *
 * WHY THIS EXISTS. Anthropic's SDK requires `max_tokens` on every request, so
 * that provider had to hardcode one — 1500, which is ample for the insight
 * extraction this interface was originally written for and roughly 6 KB of
 * HTML for anything else. A note summary of a two-hour lecture runs straight
 * through it, and Anthropic does not shorten its answer to fit: it stops
 * mid-token, so what comes back is a document cut off mid-tag. The note
 * summariser's sanitizer then rejects the whole thing for being unbalanced,
 * and the feature simply does not work for any user on an Anthropic BYOK key.
 *
 * The other three set no cap at all, and must keep setting none unless asked —
 * a cap silently acquired by every existing caller would be a regression in
 * the other direction.
 *
 * Both halves are asserted per provider: honoured when passed, previous
 * behaviour exactly when omitted.
 */

const MESSAGES: LlmChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
];
const SCHEMA = { type: 'object', properties: {} };

function args(maxTokens?: number) {
  return {
    messages: MESSAGES,
    model: 'test-model',
    schemaName: 'test_schema',
    schema: SCHEMA,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

describe('AnthropicProvider.extractStructured max_tokens', () => {
  function build() {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: 'tool_use', input: { ok: true } }],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const provider = new AnthropicProvider('test-key');
    (provider as unknown as { client: unknown }).client = {
      messages: { create },
    };
    return { provider, create };
  }

  it('uses the caller-supplied ceiling', async () => {
    const { provider, create } = build();
    await provider.extractStructured(args(4000));
    expect(create.mock.calls[0][0].max_tokens).toBe(4000);
  });

  it('keeps its historical 1500 when none is given', async () => {
    const { provider, create } = build();
    await provider.extractStructured(args());
    expect(create.mock.calls[0][0].max_tokens).toBe(1500);
  });
});

describe('OpenAiProvider.extractStructured max_tokens', () => {
  function build() {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    const provider = new OpenAiProvider('test-key');
    (provider as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
    return { provider, create };
  }

  it('passes the ceiling through when asked', async () => {
    const { provider, create } = build();
    await provider.extractStructured(args(4000));
    expect(create.mock.calls[0][0].max_tokens).toBe(4000);
  });

  it('sets no ceiling at all when none is given', async () => {
    const { provider, create } = build();
    await provider.extractStructured(args());
    expect(create.mock.calls[0][0]).not.toHaveProperty('max_tokens');
  });
});

describe('OpenRouterProvider.extractStructured max_tokens', () => {
  function build(firstCallFails = false) {
    const create = jest.fn();
    if (firstCallFails) {
      create.mockRejectedValueOnce(new Error('response_format unsupported'));
    }
    create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    const provider = new OpenRouterProvider('test-key');
    (provider as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
    return { provider, create };
  }

  it('passes the ceiling through when asked', async () => {
    const { provider, create } = build();
    await provider.extractStructured(args(4000));
    expect(create.mock.calls[0][0].max_tokens).toBe(4000);
  });

  it('also applies it to the plain-text fallback request', async () => {
    // The fallback is a second, independent request. A ceiling that reached
    // only the first one would silently stop applying for exactly the models
    // that need the fallback.
    const { provider, create } = build(true);
    await provider.extractStructured(args(4000));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].max_tokens).toBe(4000);
  });

  it('sets no ceiling at all when none is given', async () => {
    const { provider, create } = build();
    await provider.extractStructured(args());
    expect(create.mock.calls[0][0]).not.toHaveProperty('max_tokens');
  });
});

describe('GeminiProvider.extractStructured maxOutputTokens', () => {
  function build() {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        text: () => '{"ok":true}',
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    });
    const getGenerativeModel = jest.fn().mockReturnValue({ generateContent });
    const provider = new GeminiProvider('test-key');
    (provider as unknown as { client: unknown }).client = {
      getGenerativeModel,
    };
    return { provider, getGenerativeModel };
  }

  it('passes the ceiling through as maxOutputTokens', async () => {
    const { provider, getGenerativeModel } = build();
    await provider.extractStructured(args(4000));
    expect(
      getGenerativeModel.mock.calls[0][0].generationConfig.maxOutputTokens,
    ).toBe(4000);
  });

  it('sets no ceiling at all when none is given', async () => {
    const { provider, getGenerativeModel } = build();
    await provider.extractStructured(args());
    expect(
      getGenerativeModel.mock.calls[0][0].generationConfig,
    ).not.toHaveProperty('maxOutputTokens');
  });
});
