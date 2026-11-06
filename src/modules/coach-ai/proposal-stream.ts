import {
  LlmStreamChunk,
  LlmUsage,
} from '../../shared/services/llm/llm.interface';

const OPEN = '```coach-proposal';
const CLOSE = '```';

/**
 * Pass a reply through token by token, EXCEPT any ```coach-proposal block:
 * that is held back until it is complete, handed to `finalize`, and replaced
 * by whatever `finalize` returns (the block as is, a repaired block, or a
 * plain message when it could not be repaired). The client therefore never
 * renders a card that has not been checked against the user's schedule.
 *
 * The clients already show "Preparing a proposed change" while a block is
 * open; with the block held back they just see the prose pause. Text after
 * the block streams as normal. `finalize` may add token usage (repair calls),
 * which is merged into the terminal chunk so BYOK accounting stays right.
 */
export async function* guardProposalStream(
  source: AsyncIterable<LlmStreamChunk>,
  finalize: (
    blockBody: string,
    proseSoFar: string,
  ) => Promise<{ text: string; usage?: LlmUsage }>,
): AsyncGenerator<LlmStreamChunk> {
  let pending = ''; // text not yet emitted
  let emitted = '';
  let inBlock = false;
  let extra: LlmUsage = { promptTokens: 0, completionTokens: 0 };

  const flushSafe = function* (final: boolean): Generator<LlmStreamChunk> {
    // Outside a block: emit everything except a tail that could be the start
    // of an opening fence still arriving.
    if (inBlock) return;
    let keep = 0;
    if (!final) {
      for (let k = Math.min(OPEN.length, pending.length); k > 0; k--) {
        if (OPEN.startsWith(pending.slice(-k))) {
          keep = k;
          break;
        }
      }
    }
    const out = pending.slice(0, pending.length - keep);
    pending = pending.slice(pending.length - keep);
    if (out) {
      emitted += out;
      yield { delta: out, done: false };
    }
  };

  for await (const chunk of source) {
    if (chunk.delta) pending += chunk.delta;

    for (;;) {
      if (!inBlock) {
        const at = pending.indexOf(OPEN);
        if (at === -1) break;
        const before = pending.slice(0, at);
        if (before) {
          emitted += before;
          yield { delta: before, done: false };
        }
        pending = pending.slice(at + OPEN.length);
        inBlock = true;
      }
      const end = pending.indexOf(CLOSE);
      if (end === -1) break;
      const body = pending.slice(0, end);
      pending = pending.slice(end + CLOSE.length);
      inBlock = false;
      const result = await finalize(body.trim(), emitted);
      if (result.usage) {
        extra = {
          promptTokens: extra.promptTokens + result.usage.promptTokens,
          completionTokens:
            extra.completionTokens + result.usage.completionTokens,
        };
      }
      if (result.text) {
        emitted += result.text;
        yield { delta: result.text, done: false };
      }
    }

    if (chunk.done) {
      if (inBlock) {
        // The model stopped mid-block. Run what arrived through finalize so
        // a truncated card is never shown raw.
        inBlock = false;
        const result = await finalize(pending.trim(), emitted);
        pending = '';
        if (result.usage) {
          extra = {
            promptTokens: extra.promptTokens + result.usage.promptTokens,
            completionTokens:
              extra.completionTokens + result.usage.completionTokens,
          };
        }
        if (result.text) yield { delta: result.text, done: false };
      }
      yield* flushSafe(true);
      yield {
        delta: '',
        done: true,
        usage: {
          promptTokens: (chunk.usage?.promptTokens ?? 0) + extra.promptTokens,
          completionTokens:
            (chunk.usage?.completionTokens ?? 0) + extra.completionTokens,
        },
      };
      return;
    }
    yield* flushSafe(false);
  }
  // Source ended without a done chunk.
  yield* flushSafe(true);
}
