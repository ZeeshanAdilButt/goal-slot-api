/**
 * Pure helpers for a note's stored HTML body and for matching one of a
 * user's notes by a spoken/typed title.
 *
 * Mirrors goalslot-mobile's `apps/mobile/src/lib/note-content.ts` on the
 * append side (`normalizeNoteContent`/`escapeNoteHtml`/`appendNoteParagraph`
 * are byte-for-byte the same rule as that file's
 * `normalizeContent`/`escapeNoteHtml`/`appendNoteParagraph`): a note's
 * `content` column is TipTap-authored HTML (see the `Note` Prisma model —
 * the `'[]'` default is a legacy JSON-blocks placeholder no current writer
 * emits, normalized away here exactly like the client does). Do not
 * "improve" the append rule here without changing the mobile copy in the
 * same commit, or a paragraph added by the Coach and one added by the
 * mobile voice command (`appendNoteParagraph` in note-content.ts, reached via
 * the APPEND_NOTE voice intent) will start looking different for the same
 * kind of write.
 *
 * The matching side (`matchNotesByTitle`) has no mobile equivalent: the
 * mobile voice command already has a *resolved* target (the user picked a
 * page from a list, or Tier 1's local matcher found one via
 * `packages/shared/src/voice/resolve.ts`'s phonetic/edit-distance scoring,
 * built for transcription noise). The Coach has neither — the chat model is
 * never given the user's note titles (unlike goals/tasks/schedule blocks, on
 * purpose: notes can be long and numerous, and stuffing every title into
 * every chat turn's context is not worth it for a feature this narrow), so
 * it can only pass along whatever title-ish phrase the user typed. Matching
 * therefore happens here, server-side, against the user's real notes at
 * apply time — deliberately titled matching in the same STRICT spirit as
 * `titlesMatch`/`normalizeTitle` in coach-proposals.service.ts (exact,
 * case/whitespace-insensitive) with a substring fallback, never a phonetic
 * or fuzzy-distance one: a typed title has none of the transcription noise
 * the voice matcher was built to survive, so a looser match would only
 * increase the odds of silently picking the wrong page.
 */

/** The API defaults new rows to '[]' (legacy JSON-blocks format) — treat
 *  that, and whitespace-only strings, as an empty document rather than
 *  writing the literal characters into a fresh append. */
export function normalizeNoteContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed === '' || trimmed === '[]') return '';
  return content;
}

/** Escapes text for safe inclusion inside the note's HTML body. Needed here
 *  specifically because this writes a Coach-approved sentence nobody has
 *  hand-authored in the editor straight into TipTap's stored HTML — without
 *  this, a stray `<`/`&`/`"` in what the user said would be parsed as markup
 *  instead of shown as the text they actually meant. */
export function escapeNoteHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Appends one paragraph onto an existing note's HTML body as its own `<p>`
 * block. Escaped and wrapped rather than spliced into whatever markup
 * already ends the document, so it always lands as a new, well-formed block
 * instead of merging into whatever tag the existing content happened to end
 * with — same reasoning as the mobile copy this mirrors.
 */
export function appendNoteParagraph(
  existingContent: string,
  addition: string,
): string {
  return `${normalizeNoteContent(existingContent)}<p>${escapeNoteHtml(addition)}</p>`;
}

/**
 * Normalize a title for comparison: trim, lowercase, collapse internal
 * whitespace runs to a single space. Same rule as coach-proposals.service.ts's
 * own `normalizeTitle` (schedule blocks) — kept as an independent copy here
 * rather than a shared import so the notes module never has to depend on the
 * coach-proposals module for a three-line string rule.
 */
function normalizeTitleForMatch(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface NoteMatchCandidate {
  readonly id: string;
  readonly title: string;
}

export type NoteTitleMatchResult<T extends NoteMatchCandidate> =
  | { status: 'resolved'; note: T }
  | { status: 'ambiguous'; candidates: readonly T[] }
  | { status: 'no-match' };

/**
 * Find the note a title hint most plausibly refers to, among one user's own
 * notes.
 *
 * Two tiers, strongest first, mirroring `resolveStaleScheduleBlock`'s
 * "first tier with any hits decides" shape in coach-proposals.service.ts:
 *   1. Exact title match (case/whitespace-normalized).
 *   2. Substring match, either direction — the hint is contained in the
 *      note's title ("papers" -> "Research Papers") or the note's title is
 *      contained in the hint ("my research papers page" -> "Research
 *      Papers"). Notes have no unique-title constraint, so either tier can
 *      still turn up more than one candidate.
 *
 * Exactly one hit at a tier resolves. Zero hits falls through to the next,
 * weaker tier (falls through to 'no-match' after the last one). More than
 * one hit at a tier is 'ambiguous' — a false match that appends to the wrong
 * page is worse than asking, which is exactly the call
 * `resolveStaleScheduleBlock` already makes for the same reason.
 */
export function matchNotesByTitle<T extends NoteMatchCandidate>(
  notes: readonly T[],
  titleHint: string,
): NoteTitleMatchResult<T> {
  const hint = normalizeTitleForMatch(titleHint);
  if (hint.length === 0) return { status: 'no-match' };

  const exact = notes.filter((n) => normalizeTitleForMatch(n.title) === hint);
  if (exact.length === 1) return { status: 'resolved', note: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact };

  // Empty-titled notes are excluded from the substring tier: an empty
  // normalized title is a substring of every hint (and every hint a
  // "substring" of it in the degenerate sense), which would otherwise make a
  // blank-titled note match everything.
  const partial = notes.filter((n) => {
    const t = normalizeTitleForMatch(n.title);
    return t.length > 0 && (t.includes(hint) || hint.includes(t));
  });
  if (partial.length === 1) return { status: 'resolved', note: partial[0] };
  if (partial.length > 1) return { status: 'ambiguous', candidates: partial };

  return { status: 'no-match' };
}
