import {
  LlmStreamChunk,
  LlmUsage,
} from '../../shared/services/llm/llm.interface';

const OPEN = '```coach-proposal';
const CLOSE = '```';

/** A line this long is prose in its own right, not a lead-in to a card. */
const LEAD_IN_MAX = 300;

/**
 * A line that only makes sense if a card follows ("Here's how the actions
 * will look in the proposal:", "Here is the change:"). Dropped when the card
 * is not shown, so the reply never points at something that is not there.
 */
const LEAD_IN =
  /(:\s*$)|\b(proposal|card|below|the actions|the changes?|apply|approve)\b/i;

const LIST_ITEM = /^\s*(\d+[.)]|[-*•])\s+/;

/**
 * Where the text that may still turn out to introduce a proposal begins: the
 * trailing run of list items, blank lines and lead-in lines ("Here's a
 * proposal that captures each change step by step:", "1. Rename Book",
 * "Here's how the actions will look:"). Production showed the cost of
 * streaming that eagerly: a 12-point plan of changes that were never made,
 * then a withdrawn card. Held text is released as soon as ordinary prose
 * follows it, shown with the card when one is shown, and dropped when not.
 *
 * `atFence`: the text ends where a block starts, so its last line is
 * complete. Otherwise an unfinished short last line is held too, since it may
 * still grow into a lead-in.
 */
export function planRegionStart(text: string, atFence: boolean): number {
  const lines = text.split('\n');
  let end = text.length;
  let start = text.length;
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k];
    const lineStart = end - line.length;
    const t = line.trim();
    const unfinished = !atFence && k === lines.length - 1 && t.length > 0;
    const hold =
      t === '' ||
      LIST_ITEM.test(line) ||
      (t.length <= LEAD_IN_MAX && LEAD_IN.test(t)) ||
      (unfinished && t.length <= LEAD_IN_MAX);
    if (!hold) break;
    start = lineStart;
    end = lineStart - 1;
  }
  // Blank lines alone are not worth holding.
  return text.slice(start).trim() === '' ? text.length : start;
}

export interface FinalizeResult {
  text: string;
  usage?: LlmUsage;
  /**
   * Whether `text` is a card. When false (the block was withheld, or the
   * model asked a question instead), the lead-in line before the block and
   * everything the original reply said AFTER the block are dropped: that
   * text describes a card the user will never see ("Please review this
   * proposal and let me know if everything looks correct").
   */
  card?: boolean;
}

/**
 * Pass a reply through token by token, EXCEPT any ```coach-proposal block:
 * that is held back until it is complete, handed to `finalize`, and replaced
 * by whatever `finalize` returns (the block as is, a repaired block, or a
 * plain message when it could not be repaired). The client therefore never
 * renders a card that has not been checked against the user's schedule.
 *
 * The current line is also held back while it is short, because it may turn
 * out to be the lead-in to a block. It is released as soon as a newline
 * arrives or it grows past LEAD_IN_MAX, so ordinary prose still streams line
 * by line. `finalize` may add token usage (repair calls), which is merged
 * into the terminal chunk so BYOK accounting stays right.
 */
export async function* guardProposalStream(
  source: AsyncIterable<LlmStreamChunk>,
  finalize: (blockBody: string, proseSoFar: string) => Promise<FinalizeResult>,
): AsyncGenerator<LlmStreamChunk> {
  let pending = ''; // text not yet emitted
  let emitted = '';
  let inBlock = false;
  let suppressRest = false;
  // The lead-in line held while its block streams in. Per call, never
  // module-level: concurrent streams must not share it.
  let heldLeadIn = '';
  let extra: LlmUsage = { promptTokens: 0, completionTokens: 0 };

  const addUsage = (u?: LlmUsage) => {
    if (!u) return;
    extra = {
      promptTokens: extra.promptTokens + u.promptTokens,
      completionTokens: extra.completionTokens + u.completionTokens,
    };
  };

  const emit = function* (text: string): Generator<LlmStreamChunk> {
    if (!text || suppressRest) return;
    emitted += text;
    yield { delta: text, done: false };
  };

  /**
   * Outside a block, emit what is safe: everything except (a) a tail that
   * could be the start of an opening fence still arriving, and (b) a short
   * trailing line that could be a lead-in to a block.
   */
  const flushSafe = function* (final: boolean): Generator<LlmStreamChunk> {
    if (inBlock) return;
    if (final) {
      const out = pending;
      pending = '';
      yield* emit(out);
      return;
    }
    let keep = 0;
    for (let k = Math.min(OPEN.length, pending.length); k > 0; k--) {
      if (OPEN.startsWith(pending.slice(-k))) {
        keep = k;
        break;
      }
    }
    keep = Math.max(keep, pending.length - planRegionStart(pending, false));
    const out = pending.slice(0, pending.length - keep);
    pending = pending.slice(pending.length - keep);
    yield* emit(out);
  };

  /** Split text before a fence into what streams now and the held plan/lead-in. */
  const splitLeadIn = (before: string): [string, string] => {
    const start = planRegionStart(before, true);
    return [before.slice(0, start), before.slice(start)];
  };

  const runFinalize = async function* (
    body: string,
    leadIn: string,
  ): AsyncGenerator<LlmStreamChunk> {
    const result = await finalize(body, emitted);
    addUsage(result.usage);
    if (result.card === false) {
      // No card: the plan, the lead-in and the rest of the original reply
      // would talk about a card that is not there. Show only the replacement
      // text, joined to what already streamed by exactly one blank line.
      const text = emitted.endsWith('\n\n')
        ? result.text.replace(/^\n+/, '')
        : emitted.endsWith('\n')
          ? result.text.replace(/^\n+/, '\n')
          : result.text;
      yield* emit(text);
      suppressRest = true;
      return;
    }
    yield* emit(leadIn);
    yield* emit(result.text);
  };

  for await (const chunk of source) {
    if (chunk.delta && !suppressRest) pending += chunk.delta;

    for (;;) {
      if (suppressRest) {
        pending = '';
        break;
      }
      if (!inBlock) {
        const at = pending.indexOf(OPEN);
        if (at === -1) break;
        const [now, held] = splitLeadIn(pending.slice(0, at));
        yield* emit(now);
        heldLeadIn = held;
        pending = pending.slice(at + OPEN.length);
        inBlock = true;
      }
      const end = pending.indexOf(CLOSE);
      if (end === -1) break;
      const body = pending.slice(0, end);
      pending = pending.slice(end + CLOSE.length);
      inBlock = false;
      yield* runFinalize(body.trim(), heldLeadIn);
      heldLeadIn = '';
    }

    if (chunk.done) {
      if (inBlock) {
        // The model stopped mid-block. Run what arrived through finalize so
        // a truncated card is never shown raw.
        inBlock = false;
        const body = pending;
        pending = '';
        yield* runFinalize(body.trim(), heldLeadIn);
        heldLeadIn = '';
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
