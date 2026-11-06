import { CoachProvider } from '@prisma/client';

/**
 * Which model runs the proposal repair rounds.
 *
 * Production, 2026-11-06: gpt-4o-mini was given the concrete problems with
 * its proposal and told to use SPLIT_SCHEDULE_BLOCK, and still could not
 * produce a valid one; it withdrew and asked a question instead. A repair
 * round is a narrow, well-specified task (here are the ids, here is the block
 * in the way, use this action), which a stronger sibling on the SAME provider
 * and the SAME key does reliably. So small-tier chat models are escalated for
 * the repair rounds only; the user's chosen model still writes the reply.
 *
 * The operator's shared Gemini key is never escalated: it runs on a free tier
 * whose per-model daily quota is the binding constraint, and gemini-2.5-flash
 * is already what it uses.
 */
const ESCALATE: Partial<Record<CoachProvider, Record<string, string>>> = {
  OPENAI: {
    'gpt-4o-mini': 'gpt-4.1',
    'gpt-4.1-mini': 'gpt-4.1',
    'gpt-4.1-nano': 'gpt-4.1',
  },
  GEMINI: {
    'gemini-2.5-flash-lite': 'gemini-2.5-flash',
    'gemini-2.0-flash-lite': 'gemini-2.5-flash',
    'gemini-2.0-flash': 'gemini-2.5-flash',
  },
  ANTHROPIC: {
    'claude-3-5-haiku-20241022': 'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001': 'claude-sonnet-4-6',
  },
};

export function repairModelFor(
  provider: CoachProvider,
  model: string,
  isShared: boolean,
): string {
  if (isShared) return model;
  return ESCALATE[provider]?.[model] ?? model;
}
