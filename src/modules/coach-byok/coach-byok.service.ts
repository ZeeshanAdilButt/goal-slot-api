import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CoachProvider } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../shared/services/encryption.service';
import { LlmFactory, isAllowedModel } from '../../shared/services/llm/llm-factory';
import { SaveByokKeyDto } from './dto/save-byok-key.dto';
import { ByokStateDto } from './dto/byok-state.dto';
import { UsageDto } from './dto/usage.dto';

const PROVIDER_PREFIXES: Record<CoachProvider, string[]> = {
  OPENAI: ['sk-'],
  ANTHROPIC: ['sk-ant-'],
  // Google AI Studio (Gemini) keys are issued as plain Google API
  // keys with the standard AIza prefix.
  GEMINI: ['AIza'],
  // OpenRouter keys are issued as `sk-or-v1-...` today; we accept
  // any `sk-or-` prefix so future revisions don't break the check.
  OPENROUTER: ['sk-or-'],
};

@Injectable()
export class CoachByokService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly llmFactory: LlmFactory,
  ) {}

  async getState(userId: string): Promise<ByokStateDto> {
    const [row, shared] = await Promise.all([
      this.prisma.encryptedByokKey.findUnique({ where: { userId } }),
      this.getSharedUsage(userId),
    ]);
    if (!row) {
      // No personal key, but tell the client whether the shared
      // Gemini Flash fallback is configured so the Coach UI can offer
      // a "try free" button + show the daily quota meter.
      return { status: 'unset', shared };
    }
    return {
      status: 'active',
      provider: row.provider,
      maskedKey: row.maskedHint,
      tokensUsed: row.tokensUsedThisMonth,
      tokensLimit: row.tokensLimit,
      selectedModel: row.selectedModel,
      allowedModels: this.llmFactory.allowedModels(row.provider),
      effectiveModel: this.llmFactory.resolveModel(row.provider, row.selectedModel),
      shared,
    };
  }

  /**
   * Inline shared-usage lookup so the BYOK module doesn't need to
   * cross-import the CoachAiService (would create a module cycle).
   * Mirrors CoachAiService.getSharedUsageSummary exactly.
   */
  private async getSharedUsage(
    userId: string,
  ): Promise<{ available: boolean; used: number; limit: number }> {
    const sharedKey = process.env.GOOGLE_AI_SHARED_API_KEY;
    if (!sharedKey || sharedKey.length === 0) {
      return { available: false, used: 0, limit: 0 };
    }
    const limit = parseInt(process.env.SHARED_COACH_DAILY_LIMIT ?? '20', 10);
    const today = new Date();
    const day = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const usage = await this.prisma.sharedCoachUsage.findUnique({
      where: { userId_day: { userId, day } },
    });
    return {
      available: true,
      used: usage?.messageCount ?? 0,
      limit,
    };
  }

  async updateModel(userId: string, model: string): Promise<ByokStateDto> {
    const row = await this.prisma.encryptedByokKey.findUnique({
      where: { userId },
    });
    if (!row) throw new NotFoundException('No BYOK key configured');
    if (!isAllowedModel(row.provider, model)) {
      throw new BadRequestException(
        `Model "${model}" is not on the allowed list for provider ${row.provider}`,
      );
    }
    await this.prisma.encryptedByokKey.update({
      where: { userId },
      data: { selectedModel: model },
    });
    return this.getState(userId);
  }

  async saveKey(userId: string, dto: SaveByokKeyDto): Promise<ByokStateDto> {
    const trimmed = dto.apiKey.trim();
    this.assertPrefixMatches(dto.provider, trimmed);

    // Encrypt — never log plaintext, ciphertext, or any of these buffers.
    const enc = this.encryption.encrypt(trimmed);
    // Prisma v7 expects `Uint8Array<ArrayBuffer>` for Bytes columns; Node
    // Buffers are `Buffer<ArrayBufferLike>` and don't satisfy the stricter
    // type. A fresh Uint8Array copy gives us the exact backing type.
    const ciphertext = new Uint8Array(enc.ciphertext);
    const iv = new Uint8Array(enc.iv);
    const authTag = new Uint8Array(enc.authTag);

    const maskedHint = this.buildMaskedHint(dto.provider, trimmed);
    const now = new Date();

    await this.prisma.encryptedByokKey.upsert({
      where: { userId },
      create: {
        userId,
        provider: dto.provider,
        ciphertext,
        iv,
        authTag,
        maskedHint,
      },
      update: {
        provider: dto.provider,
        ciphertext,
        iv,
        authTag,
        maskedHint,
        lastValidatedAt: null,
        tokensUsedThisMonth: 0,
        tokensWindowStart: now,
      },
    });

    return this.getState(userId);
  }

  async deleteKey(userId: string): Promise<{ success: true }> {
    await this.prisma.encryptedByokKey.deleteMany({ where: { userId } });
    return { success: true };
  }

  async updateTokenBudget(
    userId: string,
    tokensLimit: number,
  ): Promise<ByokStateDto> {
    const row = await this.prisma.encryptedByokKey.findUnique({
      where: { userId },
    });
    if (!row) {
      throw new NotFoundException('No BYOK key configured');
    }
    await this.prisma.encryptedByokKey.update({
      where: { userId },
      data: { tokensLimit },
    });
    return this.getState(userId);
  }

  async getUsage(userId: string): Promise<UsageDto> {
    const row = await this.prisma.encryptedByokKey.findUnique({
      where: { userId },
    });
    if (!row) {
      throw new NotFoundException('No BYOK key configured');
    }
    return {
      tokensUsed: row.tokensUsedThisMonth,
      tokensLimit: row.tokensLimit,
      windowStart: row.tokensWindowStart,
    };
  }

  private assertPrefixMatches(provider: CoachProvider, apiKey: string): void {
    const prefixes = PROVIDER_PREFIXES[provider];
    const ok = prefixes.some((p) => apiKey.startsWith(p));
    if (!ok) {
      // SECURITY: do not include the api key (or any portion of it) in the error.
      throw new BadRequestException(
        `API key does not match expected prefix for provider ${provider}`,
      );
    }
  }

  private buildMaskedHint(provider: CoachProvider, apiKey: string): string {
    const prefix = PROVIDER_PREFIXES[provider][0];
    const last4 = apiKey.slice(-4);
    return `${prefix}...${last4}`;
  }
}
