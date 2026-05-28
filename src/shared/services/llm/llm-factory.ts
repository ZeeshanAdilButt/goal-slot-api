import { Injectable } from '@nestjs/common';
import { CoachProvider } from '@prisma/client';
import { CoachLlmProvider } from './llm.interface';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';

/**
 * Allowed model whitelist per provider. The user picks from this list in
 * Settings; anything else is rejected at the API boundary. Keep these in
 * sync with the provider names billed by OpenAI / Anthropic. Order is the
 * order shown in the UI dropdown, cheapest -> most expensive within each
 * provider so users default to the value choice.
 */
export const ALLOWED_MODELS: Record<CoachProvider, string[]> = {
  OPENAI: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4.1',
    'o4-mini',
  ],
  ANTHROPIC: [
    'claude-3-5-haiku-20241022',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
  ],
};

const DEFAULT_MODELS: Record<CoachProvider, string> = {
  OPENAI: 'gpt-4o-mini',
  ANTHROPIC: 'claude-3-5-haiku-20241022',
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
      default: {
        // Exhaustiveness — keep TS happy if the enum grows.
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
