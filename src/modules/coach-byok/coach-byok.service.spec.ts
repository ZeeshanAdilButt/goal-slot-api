import { BadRequestException } from "@nestjs/common";
import { CoachProvider } from "@prisma/client";

import { LlmFactory } from "../../shared/services/llm/llm-factory";
import { CoachByokService } from "./coach-byok.service";

class FakePrisma {
  rows = new Map<string, any>();
  sharedUsage = new Map<string, any>();

  encryptedByokKey = {
    findUnique: async ({ where }: any) => this.rows.get(where.userId) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = this.rows.get(where.userId);
      const row = existing
        ? { ...existing, ...update }
        : {
            id: `byok_${this.rows.size + 1}`,
            ...create,
            selectedModel: null,
            tokensUsedThisMonth: 0,
            tokensLimit: 100_000,
            tokensWindowStart: new Date("2026-06-01T00:00:00.000Z"),
          };
      this.rows.set(where.userId, row);
      return row;
    },
  };

  sharedCoachUsage = {
    findUnique: async ({ where }: any) => {
      const key = `${where.userId_day.userId}:${where.userId_day.day.toISOString()}`;
      return this.sharedUsage.get(key) ?? null;
    },
  };
}

class FakeEncryption {
  plaintexts: string[] = [];

  encrypt(plaintext: string) {
    this.plaintexts.push(plaintext);
    return {
      ciphertext: Buffer.from(`cipher:${plaintext}`),
      iv: Buffer.from("iv"),
      authTag: Buffer.from("auth"),
    };
  }
}

function buildService() {
  const prisma = new FakePrisma();
  const encryption = new FakeEncryption();
  const service = new CoachByokService(
    prisma as any,
    encryption as any,
    new LlmFactory(),
  );

  return { prisma, encryption, service };
}

describe("CoachByokService prefix validation", () => {
  const validCases: Array<{
    provider: CoachProvider;
    apiKey: string;
    expectedHint: string;
  }> = [
    {
      provider: "OPENAI",
      apiKey: "sk-test-abcd1234",
      expectedHint: "sk-...1234",
    },
    {
      provider: "ANTHROPIC",
      apiKey: "sk-ant-abc1234",
      expectedHint: "sk-ant-...1234",
    },
    {
      provider: "GEMINI",
      apiKey: "AIzaSyExampleKey1234",
      expectedHint: "AIza...1234",
    },
    {
      provider: "OPENROUTER",
      apiKey: "sk-or-v1-example1234",
      expectedHint: "sk-or-...1234",
    },
  ];

  it.each(validCases)(
    "accepts a correctly-prefixed $provider key and returns a masked hint",
    async ({ provider, apiKey, expectedHint }) => {
      const { prisma, service } = buildService();

      const state = await service.saveKey("user_1", { provider, apiKey });

      expect(state.status).toBe("active");
      expect(state.provider).toBe(provider);
      expect(state.maskedKey).toBe(expectedHint);
      expect(prisma.rows.get("user_1").maskedHint).toBe(expectedHint);
    },
  );

  const invalidCases: Array<{
    provider: CoachProvider;
    apiKey: string;
    leakedFragment: string;
  }> = [
    {
      provider: "OPENAI",
      apiKey: "ak-test-abcd1234",
      leakedFragment: "abcd1234",
    },
    { provider: "ANTHROPIC", apiKey: "sk-abc1234", leakedFragment: "abc1234" },
    {
      provider: "GEMINI",
      apiKey: "sk-example1234",
      leakedFragment: "example1234",
    },
    {
      provider: "OPENROUTER",
      apiKey: "sk-anything1234",
      leakedFragment: "anything1234",
    },
    { provider: "OPENAI", apiKey: "", leakedFragment: "" },
  ];

  it.each(invalidCases)(
    "rejects an invalid $provider key without echoing the secret",
    async ({ provider, apiKey, leakedFragment }) => {
      const { service } = buildService();

      await expect(
        service.saveKey("user_1", { provider, apiKey }),
      ).rejects.toThrow(BadRequestException);

      try {
        await service.saveKey("user_1", { provider, apiKey });
        throw new Error("expected saveKey to reject");
      } catch (err: any) {
        const response = err.getResponse();
        const serialized = JSON.stringify(response);
        expect(serialized).toContain(provider);
        if (apiKey) {
          expect(serialized).not.toContain(apiKey);
        }
        if (leakedFragment) {
          expect(serialized).not.toContain(leakedFragment);
        }
      }
    },
  );

  it("trims leading and trailing whitespace before validation and encryption", async () => {
    const { encryption, service } = buildService();

    const state = await service.saveKey("user_1", {
      provider: "OPENAI",
      apiKey: "  sk-test-abcd1234  ",
    });

    expect(state.maskedKey).toBe("sk-...1234");
    expect(encryption.plaintexts).toEqual(["sk-test-abcd1234"]);
  });

  it("uses the more specific Anthropic prefix instead of the generic OpenAI prefix", async () => {
    const { service } = buildService();

    await expect(
      service.saveKey("user_1", {
        provider: "ANTHROPIC",
        apiKey: "sk-test-abcd1234",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("does not include the middle of the key in the masked hint", async () => {
    const { service } = buildService();

    const state = await service.saveKey("user_1", {
      provider: "OPENROUTER",
      apiKey: "sk-or-v1-middle-secret-9999",
    });

    expect(state.maskedKey).toBe("sk-or-...9999");
    expect(state.maskedKey).not.toContain("middle-secret");
  });
});
