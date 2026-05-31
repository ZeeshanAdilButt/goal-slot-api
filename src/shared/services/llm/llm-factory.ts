import { Injectable } from '@nestjs/common';
import { CoachProvider } from '@prisma/client';
import { CoachLlmProvider } from './llm.interface';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { OpenRouterProvider } from './openrouter-provider';

/**
 * Allowed model whitelist per provider. The user picks from this list in
 * Settings; anything else is rejected at the API boundary. Keep these in
 * sync with the provider names billed by OpenAI / Anthropic. Order is the
 * order shown in the UI dropdown, cheapest -> most expensive within each
 * provider so users default to the value choice.
 */
export const ALLOWED_MODELS: Record<CoachProvider, string[]> = {
  OPENAI: [
    // 4-series (cheap, fast)
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4.1',
    // o-series reasoning
    'o4-mini',
    'o3',
    'o3-mini',
    // 5-series (latest, more capable, more expensive)
    'gpt-5-mini',
    'gpt-5',
    'gpt-5.4',
    'gpt-5.5',
  ],
  ANTHROPIC: [
    'claude-3-5-haiku-20241022',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
  ],
  // Google AI Studio (Gemini). Free tier covers Flash models with generous
  // limits and no credit card required. Pro variants are paid but cheap.
  GEMINI: [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.5-pro',
  ],
  // OpenRouter aggregator. The `:free` suffix is the community-hosted
  // free tier; paid alternatives use the same naming without the suffix.
  // We curate a handful of strong free models plus a couple of paid
  // anchors so users have an obvious "try free / pay for top quality" pick.
  OPENROUTER: [
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-chat-v3.1:free',
    'qwen/qwen3-coder:free',
    'mistralai/mistral-small-3.2-24b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'anthropic/claude-3.5-haiku',
    'openai/gpt-4o-mini',
  ],
};

const DEFAULT_MODELS: Record<CoachProvider, string> = {
  OPENAI: 'gpt-4o-mini',
  ANTHROPIC: 'claude-3-5-haiku-20241022',
  GEMINI: 'gemini-2.5-flash',
  OPENROUTER: 'meta-llama/llama-3.3-70b-instruct:free',
};

export function isAllowedModel(
  provider: CoachProvider,
  model: string,
): boolean {
  return ALLOWED_MODELS[provider]?.includes(model) ?? false;
}

@Injectable()
export class LlmFactory {
  /**
   * Build a provider instance bound to the given decrypted API key.
   *
   * SECURITY: callers must capture the decrypted key into a local variable
   * BEFORE invoking this factory so that a concurrent BYOK delete cannot
   * race the open stream. The factory itself does not persist or log the key.
   */
  create(provider: CoachProvider, apiKey: string): CoachLlmProvider {
    switch (provider) {
      case 'OPENAI':
        return new OpenAiProvider(apiKey);
      case 'ANTHROPIC':
        return new AnthropicProvider(apiKey);
      case 'GEMINI':
        return new GeminiProvider(apiKey);
      case 'OPENROUTER':
        return new OpenRouterProvider(apiKey);
      default: {
        const _exhaustive: never = provider;
        throw new Error(`Unsupported coach provider: ${_exhaustive as string}`);
      }
    }
  }

  defaultModel(provider: CoachProvider): string {
    return DEFAULT_MODELS[provider];
  }

  /**
   * Pick the model to use for this call: the user's selection if it is on
   * the whitelist, otherwise the provider default.
   */
  resolveModel(provider: CoachProvider, userSelection?: string | null): string {
    if (userSelection && isAllowedModel(provider, userSelection)) {
      return userSelection;
    }
    return DEFAULT_MODELS[provider];
  }

  allowedModels(provider: CoachProvider): string[] {
    return ALLOWED_MODELS[provider] ?? [];
  }
}
