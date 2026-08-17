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
 * built for transcription noise). The Coach's chat context DOES now list the
 * user's real note titles, so a well-behaved model can echo one back
 * verbatim — but `titleHint` is still free text the model composes, so it can
 * and does arrive as a phrase ("put this in my meeting notes page") rather
 * than a title. Matching therefore still happens here, server-side, against
 * the user's real notes at apply time — deliberately titled matching in the
 * same STRICT spirit as `titlesMatch`/`normalizeTitle` in
 * coach-proposals.service.ts (exact, case/whitespace-insensitive) with a
 * bounded substring fallback, never a phonetic or fuzzy-distance one: a typed
 * title has none of the transcription noise the voice matcher was built to
 * survive, so a looser match would only increase the odds of silently picking
 * the wrong page.
 *
 * That last risk is not hypothetical, and it is the reason the reverse
 * containment tier below is bounded rather than a plain `hint.includes(t)`.
 * With the extremely ordinary page set {"Notes", "Meeting Notes"}, the
 * unbounded rule resolved "notes from the meeting" to "Notes" — the wrong
 * page, silently, reporting success. Any short, generic title ("Notes",
 * "Ideas", "Log") is a substring of a great many English phrases, so the
 * unbounded rule effectively turned the most common page name in a notes app
 * into a catch-all that swallowed hints meant for its more specific
 * siblings.
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
 * Normalize a title for comparison: lowercase, fold the punctuation a person
 * types differently from how their page is titled, collapse internal
 * whitespace runs to a single space, trim.
 *
 * Started as the same rule as coach-proposals.service.ts's own
 * `normalizeTitle` (schedule blocks) and is still kept as an independent copy
 * rather than a shared import, so the notes module never has to depend on the
 * coach-proposals module for a small string rule. It has since diverged in
 * one deliberate way: the punctuation folding below.
 *
 * Apostrophes are DELETED rather than spaced, because they sit inside a word
 * ("Qur'an" -> "quran", so a hint of "quran notes" reaches "Qur'an Notes",
 * which is an exact match rather than a lucky substring). Separators are
 * turned into a SPACE rather than deleted, because they sit between words
 * ("Q1-Review" -> "q1 review", not "q1review").
 *
 * Typographic apostrophes matter specifically: iOS and macOS substitute U+2019
 * for a typed ASCII quote automatically, so a title created on the user's
 * phone routinely contains a character they cannot easily type back into
 * chat. Without this fold, the two are simply different strings.
 */
const TITLE_APOSTROPHES = /['‘’ʼ]/g;
const TITLE_SEPARATORS = /[-–—_/\\|:;,.]+/g;

function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(TITLE_APOSTROPHES, '')
    .replace(TITLE_SEPARATORS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * How much longer than a note's title the hint may be and still resolve via
 * reverse containment (tier 3). A hint of "my ideas page" (13 chars) may
 * claim the page "Ideas" (5) because 13 <= 3 * 5; "notes from the meeting"
 * (22) may NOT claim "Notes" (5), because 22 > 3 * 5.
 *
 * The ratio exists because reverse containment is the one tier where the
 * matched text can be an arbitrarily small fraction of what the user said,
 * and the smaller that fraction is, the more likely the title merely
 * *appears inside* a sentence about something else rather than *being what
 * the sentence names*. Three is deliberately generous — it comfortably
 * admits the "my <title> page/note" wrappers the Coach prompt actually
 * produces, while rejecting the full-sentence hints that were silently
 * landing on short generic pages.
 *
 * Same spirit as `DEFAULT_AMBIGUITY_MARGIN` in goalslot-mobile's
 * `packages/shared/src/voice/resolve.ts`: a weak signal has to clear a bar,
 * not merely be the only thing present.
 */
const REVERSE_CONTAINMENT_MAX_HINT_RATIO = 3;

/**
 * Find the note a title hint most plausibly refers to, among one user's own
 * notes.
 *
 * Three tiers, strongest first, mirroring `resolveStaleScheduleBlock`'s
 * "first tier with any hits decides" shape in coach-proposals.service.ts:
 *   1. Exact title match (case/punctuation/whitespace-normalized).
 *   2. Forward containment — the hint is contained in the note's title
 *      ("papers" -> "Research Papers"). The user named a real, if partial,
 *      title.
 *   3. Reverse containment — the note's title is contained in the hint
 *      ("my ideas page" -> "Ideas"). The user wrapped a title in a sentence.
 *      This is the weakest and most dangerous tier, so it is bounded twice
 *      (see below) rather than applied flat.
 *
 * Notes have no unique-title constraint, so any tier can turn up more than
 * one candidate. Exactly one hit at a tier resolves; zero falls through to
 * the next, weaker tier ('no-match' after the last). More than one is
 * 'ambiguous' — a false match that appends to the wrong page is worse than
 * asking, exactly the call `resolveStaleScheduleBlock` already makes.
 *
 * Tiers 2 and 3 were ONE tier (`t.includes(hint) || hint.includes(t)`) and
 * that is what made the wrong-page write in this file's header comment
 * possible. Splitting them means a real partial title always beats a
 * sentence that happens to contain a short title, and the two bounds on
 * tier 3 mean an unbounded sentence can no longer claim a generic page.
 *
 * 'ambiguous' stays a hard failure at every tier. There is deliberately no
 * "best guess wins" tie-break: silently appending to the wrong page is the
 * failure mode being removed here, not one to trade for a lower ask rate.
 */
export function matchNotesByTitle<T extends NoteMatchCandidate>(
  notes: readonly T[],
  titleHint: string,
): NoteTitleMatchResult<T> {
  const hint = normalizeTitleForMatch(titleHint);
  if (hint.length === 0) return { status: 'no-match' };

  // Empty-titled notes are excluded from every containment tier: an empty
  // normalized title is a substring of every hint (and every hint a
  // "substring" of it in the degenerate sense), which would otherwise make a
  // blank-titled note match everything. Computed once, since all three tiers
  // want the same normalized pairs.
  const titled = notes
    .map((note) => ({ note, title: normalizeTitleForMatch(note.title) }))
    .filter((c) => c.title.length > 0);

  const exact = titled.filter((c) => c.title === hint);
  if (exact.length === 1) return { status: 'resolved', note: exact[0].note };
  if (exact.length > 1) {
    return { status: 'ambiguous', candidates: exact.map((c) => c.note) };
  }

  const forward = titled.filter((c) => c.title.includes(hint));
  if (forward.length === 1) {
    return { status: 'resolved', note: forward[0].note };
  }
  if (forward.length > 1) {
    return { status: 'ambiguous', candidates: forward.map((c) => c.note) };
  }

  // Tier 3: reverse containment, bounded twice.
  const reverse = titled.filter((c) => hint.includes(c.title));

  // Bound 1 — prune non-maximal candidates. When "Notes" and "Meeting Notes"
  // both sit inside "put this in my meeting notes page", "Notes" is only
  // there because it is itself part of "Meeting Notes". Keeping both would
  // report 'ambiguous' for a hint that names one page perfectly well, so the
  // more specific title wins outright and the substring of it is dropped.
  // Note this compares candidates to each OTHER, not to the hint.
  const maximal = reverse.filter(
    (c) => !reverse.some((o) => o !== c && o.title.includes(c.title)),
  );

  // Bound 2 — specificity floor. What survives must account for a reasonable
  // share of what the user actually said. This is what stops "notes from the
  // meeting" from claiming "Notes": an honest 'no-match' the user can correct
  // in one sentence, instead of a silent write into the wrong page that they
  // may not notice for days.
  const specific = maximal.filter(
    (c) => hint.length <= REVERSE_CONTAINMENT_MAX_HINT_RATIO * c.title.length,
  );

  if (specific.length === 1) {
    return { status: 'resolved', note: specific[0].note };
  }
  if (specific.length > 1) {
    return { status: 'ambiguous', candidates: specific.map((c) => c.note) };
  }

  return { status: 'no-match' };
}
