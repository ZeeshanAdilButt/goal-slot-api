import { Global, Module } from '@nestjs/common';
import { LlmFactory } from '../services/llm/llm-factory';

/**
 * Global LLM module exposing the `LlmFactory`. Mirrors the encryption module
 * pattern so the factory is injectable anywhere without explicit imports.
 */
@Global()
@Module({
  providers: [LlmFactory],
  exports: [LlmFactory],
})
export class LlmModule {}
