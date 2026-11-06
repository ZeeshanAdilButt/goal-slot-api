import { normalizeTitle } from '../coach-proposals/schedule-batch-plan';

/**
 * Loose title comparison shared by the proposal guard and the quoted-title
 * check. Loose on purpose: it only feeds hints and context notes, never what
 * gets applied. The model often drops a parenthetical suffix or writes "and"
 * for "&".
 */
export function loose(title: string): string {
  return normalizeTitle(title)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\band\b/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function looseTitleMatch(a: string, b: string): boolean {
  const x = loose(a);
  const y = loose(b);
  return (
    x === y ||
    (y.length >= 4 && x.includes(y)) ||
    (x.length >= 4 && y.includes(x))
  );
}

/** Words that carry meaning in a block title (no "and", "the", "time"). */
export function titleWords(title: string): Set<string> {
  const stop = new Set([
    'and',
    'the',
    'of',
    'for',
    'time',
    'block',
    'with',
    'a',
    'to',
  ]);
  return new Set(
    normalizeTitle(title)
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

export function relatedTitles(a: string, b: string): boolean {
  if (looseTitleMatch(a, b)) return true;
  const wa = titleWords(a);
  return [...titleWords(b)].some(
    (w) => wa.has(w) || wa.has(w.replace(/s$/, '')),
  );
}

/** The user's message lowercased, whitespace collapsed, "and" as "&": comparable with `loose()` output. */
export function looseMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\band\b/g, '&');
}
