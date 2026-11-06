import { sanitizeSingleLine } from './safety/prompt-safety';
import { loose, looseTitleMatch } from './title-match';

/**
 * Titles the user put in quotes that match no block on their schedule.
 *
 * Production, 2026-11-06: the user wrote `At 5 pm, again, "Talking About
 * Weekdays" stays there`. No block has that title (5 PM is LeafCompute), the
 * Coach silently ignored the line, and the user only found out from a later
 * audit. A quoted title that matches nothing is exactly the moment to ask
 * which block they mean, so the turn's context says so.
 *
 * A quote that is a NEW name ("rename it to "Dev Weekends"") or a block to
 * create ("add a block "Gym"") is not a miss and is skipped, judged by the
 * words just before the quote.
 */

const QUOTE = /"([^"\n]{2,80})"|“([^”\n]{2,80})”/g;

/** Words right before a quote that make it a name to give, not a block to find. */
const NEW_NAME_BEFORE =
  /(\b(to|as|with|into|titled|called|named|call(ed)? (it|that|this|them)|name (it|that|this)|make (it|that|this)|rename[sd]?( (it|that|this))?)\s*$)|(\b(add|adds|adding|create|creating|new|schedule|insert|put|start|set up)\b[^"]{0,30}$)/i;

const MAX_QUOTES = 5;
const MAX_CLOSEST = 3;

function bigrams(s: string): string[] {
  const t = s.replace(/[^a-z0-9]/g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Dice coefficient on character bigrams of the loosened titles, 0 to 1. */
function similarity(a: string, b: string): number {
  const x = bigrams(loose(a));
  const y = bigrams(loose(b));
  if (x.length === 0 || y.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of x) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of y) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      hit++;
      counts.set(g, c - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

export function quotedTitles(message: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of message.matchAll(QUOTE)) {
    const title = (m[1] ?? m[2] ?? '').trim();
    if (!title) continue;
    const before = message.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
    if (NEW_NAME_BEFORE.test(before)) continue;
    const key = loose(title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

/**
 * The context lines for quoted titles that match no block, or '' when every
 * quote matches (or there are none). Deterministic: no model involved.
 */
export function renderUnmatchedQuotedTitles(
  message: string,
  blocks: Array<{ title: string }>,
): string {
  const titles = [...new Set(blocks.map((b) => b.title))];
  const lines: string[] = [];
  for (const q of quotedTitles(message)) {
    if (titles.some((t) => looseTitleMatch(t, q))) continue;
    const closest = titles
      .map((t) => ({ t, score: similarity(t, q) }))
      .filter((x) => x.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CLOSEST)
      .map((x) => `"${sanitizeSingleLine(x.t)}"`);
    lines.push(
      `  - "${sanitizeSingleLine(q)}" (${closest.length ? `closest: ${closest.join(', ')}` : 'no block has a similar title'})`,
    );
    if (lines.length >= MAX_QUOTES) break;
  }
  return lines.join('\n');
}
