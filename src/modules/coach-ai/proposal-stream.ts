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

/**
 * A sentence that says the card covers everything ("This proposal handles all
 * your requests", "I have covered each change"). Never shown next to a card
 * that was repaired: it was written about the discarded draft, and the card
 * that replaced it may cover far less (production: about 9 of 20 asks).
 */
const COVERAGE_CLAIM =
  /\b(handles?|covers?|covered|captures?|captured|addresses|addressed|takes? care of|encompass(es)?|accomplish(es)?|made|completed|implemented|included|finished|incorporated)\b[^.\n]{0,60}\b(all|every|everything|each|entire|whole|both)\b|\b(all|every|everything|each|entire|whole)\b[^.\n]{0,40}\b(requests?|changes?|asks?|items?|updates?|points?|parts?)\b[^.\n]{0,30}\b(handled|covered|done|included|captured|addressed|in (this|the) (proposal|card))\b/i;

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
  // A list item that wraps ("1. Move Book to 9\n   on Tuesday.") is one item:
  // its continuation lines are held with it, or the first half of the item
  // would stream before a repaired card replaces the plan. A continuation is
  // an indented line, or one starting in lower case, that directly follows an
  // item or another continuation (a blank line ends the item).
  const continuation: boolean[] = [];
  let inItem = false;
  for (const line of lines) {
    const t = line.trim();
    if (LIST_ITEM.test(line)) {
      inItem = true;
      continuation.push(false);
    } else if (t === '') {
      inItem = false;
      continuation.push(false);
    } else if (inItem && (/^\s+\S/.test(line) || /^[a-z(]/.test(t))) {
      continuation.push(true);
    } else {
      inItem = false;
      continuation.push(false);
    }
  }
  let end = text.length;
  let start = text.length;
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k];
    const lineStart = end - line.length;
    const t = line.trim();
    const unfinished = !atFence && k === lines.length - 1 && t.length > 0;
    const hold =
      t === '' ||
      continuation[k] ||
      LIST_ITEM.test(line) ||
      (t.length <= LEAD_IN_MAX &&
        (LEAD_IN.test(t) || COVERAGE_CLAIM.test(t))) ||
      (unfinished && t.length <= LEAD_IN_MAX);
    if (!hold) break;
    start = lineStart;
    end = lineStart - 1;
  }
  // Blank lines alone are not worth holding.
  return text.slice(start).trim() === '' ? text.length : start;
}

/** Drop the sentences of `text` that claim the card covers everything. */
export function stripCoverageClaims(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !COVERAGE_CLAIM.test(sentence))
        .join(' '),
    )
    .filter((para) => para.trim() !== '')
    .join('\n\n');
}

const FIRST_SENTENCE_MAX = 160;

/**
 * The one short sentence kept from the original lead-in of a repaired card:
 * the first sentence of its first prose line, if it is short, finishes with a
 * full stop (not "Here is the plan:"), points at no card, and claims no
 * coverage. Empty otherwise.
 */
export function shortFirstSentence(leadIn: string): string {
  const line = leadIn
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !LIST_ITEM.test(l));
  if (!line) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  const sentence = m?.[1]?.trim() ?? '';
  if (!sentence || sentence.length > FIRST_SENTENCE_MAX) return '';
  if (/\b(proposal|card|below|above|apply|approve|review)\b/i.test(sentence))
    return '';
  return stripCoverageClaims(sentence);
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
  /**
   * True when the card was REPAIRED: it is not the one the model first wrote.
   * The original reply's plan ("1. Rename Book ...") and whatever it said
   * after the block describe the discarded draft, so only a short first
   * sentence of the lead-in is kept and the rest of the original prose is
   * dropped. `text` is the replacement and speaks only for the final card.
   */
  repaired?: boolean;
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
  // After a repaired card the original reply's remaining prose is dropped.
  let dropProse = false;
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

  /** Original-reply prose: dropped once a repaired card has been shown. */
  const emitProse = function* (text: string): Generator<LlmStreamChunk> {
    if (dropProse) return;
    yield* emit(text);
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
      yield* emitProse(out);
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
    yield* emitProse(out);
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
    if (result.repaired) {
      // The plan and the claims in the original reply were written for a card
      // that was discarded. Keep one short harmless sentence, drop the rest.
      const first = shortFirstSentence(leadIn);
      if (first) yield* emit(first + '\n\n');
      yield* emit(result.text.replace(/^\n+/, ''));
      dropProse = true;
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
        yield* emitProse(now);
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
