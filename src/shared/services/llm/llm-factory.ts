import { Injectable } from '@nestjs/common';
import { CoachProvider } from '@prisma/client';
import { CoachLlmProvider } from './llm.interface';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';

const DEFAULT_MODELS: Record<CoachProvider, string> = {
  OPENAI: 'gpt-4o-mini',
  ANTHROPIC: 'claude-3-5-haiku-20241022',
};

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
}
