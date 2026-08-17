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
 * Trims a dangling trailing "to my"/"for my"/"in my"/"on my"/"into
 * my"/"onto my" (optionally followed by a bare, generic note word, and
 * optionally preceded by a comma or semicolon) off the END of a Coach-
 * proposed `content` string, before it is stored.
 *
 * WHY THIS IS SAFE. English requires a noun after a possessive determiner —
 * a clause never legitimately *ends* on "...to my" or "...for my". When the
 * Coach model's content/titleHint split lands in the wrong place on an
 * ungrammatical, comma-spliced, transcription-noisy sentence (see
 * coach-ai.prompts.ts's APPEND_NOTE_CONTENT boundary rule), the tail it
 * leaves stuck to `content` is always this kind of dangling preposition
 * phrase, reaching for a target-page reference it failed to fully separate
 * out. Stripping it recovers real content ("computer science, learning to
 * my" -> "computer science, learning") without guessing at the model's
 * intent for anything else.
 *
 * WHY THE GENERIC-NOUN TAIL IS BOUNDED, NOT OPEN-ENDED. The same dangling
 * phrase can also arrive with a bare, non-specific note word still attached
 * ("...to my notes"), which is stripped too. But the pattern stops there
 * deliberately: it does NOT reach past a generic noun to swallow a specific
 * page title ("...to my todo notes" keeps "todo" — there is no way to tell,
 * from `content` alone, that "todo" is a leaked title fragment rather than
 * the user's own words, and guessing would risk deleting real content this
 * function has no business touching). That narrower leak is only reliably
 * fixed by getting the boundary right in the first place (the prompt rule),
 * not by this defensive trim.
 *
 * WHY BARE TRAILING PREPOSITIONS ("...turn it on", "...left the light on")
 * ARE NOT TOUCHED. Those are complete, ordinary phrasal verbs a real
 * sentence can end on — only the preposition + possessive-determiner
 * combination is the unambiguous artifact.
 *
 * This is a narrow, deterministic safety net, not a parser: it cannot catch
 * every shape a boundary mistake can take (e.g. a specific title fragment
 * left dangling, as above), and it is not a substitute for the model
 * drawing the boundary correctly to begin with.
 */
// \b around each word (not just \s* separators) matters: without it, "in"
// or "to" would match as a bare substring of an ordinary word immediately
// before "my" ("...Latin my" or "...photo my"), stripping into the middle
// of a real word instead of only ever matching a standalone preposition.
const DANGLING_TARGET_REFERENCE =
  /[,;]?\s*\b(?:to|for|in|on|into|onto)\b\s+\b(?:my|our)\b(?:\s+\b(?:notes?|notebooks?|pages?)\b)?\s*$/i;

export function stripDanglingNoteReference(content: string): string {
  return content.replace(DANGLING_TARGET_REFERENCE, '').trimEnd();
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

// ---------------------------------------------------------------------------
// Note summarization: model input, and model output
//
// Both helpers below exist for the note-summary module (POST /notes/:id/summary
// — see ../note-summary/note-summary.service.ts). They live here, next to the
// other pure note-content helpers, because they are the same kind of thing: a
// rule about the shape of `Note.content`, testable without a database, a
// network, or Nest's DI container.
// ---------------------------------------------------------------------------

/** Block-level elements whose CLOSING tag ends a line of prose. */
const TEXT_BLOCK_CLOSERS =
  /<\/(?:p|div|h[1-6]|blockquote|li|tr|section|article|pre|figcaption|td|th)\s*>/gi;

/**
 * Flatten a note's stored HTML into the plain text the summarization model is
 * actually given, PRESERVING block structure as newlines.
 *
 * WHY NOT REUSE THE MOBILE `htmlToPlainText` SHAPE. goalslot-mobile has a
 * helper of nearly this name (apps/mobile/src/lib/note-content.ts) and it is
 * the wrong rule to copy here, which is worth stating explicitly because
 * copying it looks like the consistent thing to do. That one replaces EVERY
 * tag with a single space and then collapses all whitespace runs to one space,
 * because it feeds a one-line list-row preview where a newline would be
 * meaningless. Run a two-hour lecture through it and the model receives 50 KB
 * of unbroken single-line text — and paragraph and heading boundaries are the
 * single strongest signal a summarizer has for where one topic ends and the
 * next begins. Quality collapses on exactly the input this feature exists for.
 *
 * So: headings become `## `-prefixed lines, list items become `- ` bullets,
 * table cells keep a tab between them, and every block close is a newline. The
 * result is a markdown-ish rendering, which is a format every model on the
 * whitelist reads fluently and which costs far fewer tokens than the tags did.
 *
 * NOT A SANITIZER, exactly like its mobile cousin — the output is prompt text,
 * never markup written back anywhere. `sanitizeSummaryHtml` is the function
 * that defends the write path.
 */
export function noteHtmlToStructuredText(html: string): string {
  const content = normalizeNoteContent(html);
  if (content === '') return '';

  const withBreaks = content
    // Script/style bodies are not prose; dropping the tags alone would feed
    // their source code to the model as if the user had written it.
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Headings open with a markdown hash run so the model can see the outline
    // depth, not merely that "a line ended here".
    .replace(/<h([1-6])(?:\s[^>]*)?>/gi, (_m, level: string) => {
      return `\n${'#'.repeat(Number(level))} `;
    })
    .replace(/<li(?:\s[^>]*)?>/gi, '\n- ')
    // A cell boundary is a tab, not a newline: a table row should read as one
    // line of related values rather than as several unrelated ones. Web-
    // authored lecture notes really can contain tables (the web editor has
    // them), so this is a live path, not a defensive one.
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(TEXT_BLOCK_CLOSERS, '\n')
    .replace(/<[^>]*>/g, '');

  // One line per block, and runs of newlines collapse to a single one.
  // A block open and the preceding block's close each contribute a newline,
  // so without this every heading and list item would arrive preceded by a
  // blank line; and a note with a dozen empty paragraphs in it (dictation
  // leaves those behind) would otherwise spend real context on whitespace.
  // The structure the model needs is carried by the `#` and `- ` markers
  // above, not by how many newlines separate two blocks.
  return decodeNoteEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/**
 * The inverse of `escapeNoteHtml`, plus the `&nbsp;` TipTap emits for runs of
 * spaces. Mirrors goalslot-mobile's `decodeNoteEntities` including the reason
 * it is a single pass rather than a chain of `.replace` calls: chained decoding
 * is order-dependent and double-decodes (running `&amp;` first turns a literal
 * `&amp;lt;` into `&lt;` and then into `<`), whereas one scan never re-examines
 * what it just wrote.
 */
export function decodeNoteEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  };
  return text.replace(
    /&(?:amp|lt|gt|quot|#39|nbsp);/g,
    (entity) => entities[entity] ?? entity,
  );
}

/**
 * ===========================================================================
 * sanitizeSummaryHtml — the allowlist the model's HTML must pass to be stored
 * ===========================================================================
 *
 * This is the FIRST path in this API that writes model-authored MARKUP into
 * the database. Every existing writer of `Note.content` either passes through
 * something a human typed into a real editor, or escapes text wholesale
 * (`appendNoteParagraph` above). So the trust boundary here is new, and the
 * enforcement has to be a parser, not a prompt instruction — the prompt says
 * the same thing, but a prompt is a request and this is the guarantee.
 *
 * THREE separate reasons the allowlist is this narrow, all of which have to
 * hold at once:
 *
 *  1. RENDERING. Whatever comes out of here is parsed by TipTap on both
 *     clients. ProseMirror silently DISCARDS content it has no schema node
 *     for, so markup outside both schemas isn't a cosmetic problem — it is
 *     content the user never gets to see, in a note whose whole purpose is to
 *     be the readable version of something long.
 *
 *  2. THE MOBILE FORMAT LOCK. goalslot-mobile ships
 *     `hasUnsupportedMobileMarkup` (apps/mobile/src/lib/note-content.ts),
 *     which makes a note READ-ONLY on the phone when it contains a table, an
 *     `<hr>`, a `<pre>`, a `text-align` style or a `data-indent` — because the
 *     mobile editor's schema has no node for those and its autosave would
 *     otherwise write its own lossy re-serialization back over the good copy.
 *     A summary emitted with any of them would therefore be born locked: the
 *     user asks for a tidy version of their lecture and receives a page they
 *     cannot edit on the device they are holding. This allowlist can emit none
 *     of those five things, which is asserted directly in note-content.spec.ts.
 *
 *  3. SECURITY. The stored HTML is rendered by goal-slot-web's
 *     `html-content.tsx` through `dangerouslySetInnerHTML` on some surfaces,
 *     and a note can be shared by public link. "It always goes through
 *     ProseMirror first" is defence-in-depth by accident, not by design, and
 *     is not something to bet a stored-XSS on.
 *
 * WHY IT REJECTS RATHER THAN REPAIRS. A response cut off by the provider's
 * output cap ends mid-document — often mid-tag. Repairing that (auto-closing
 * the open elements) would persist half a summary that LOOKS complete, under a
 * title claiming to summarize the whole lecture, with no signal anything went
 * wrong. That is the worst possible outcome here: silent, plausible, and
 * wrong. An unbalanced document is therefore a hard failure the caller
 * surfaces as "try again", which costs one retry instead of one lie.
 */

/** Emitted as-is (after aliasing), with only the attributes listed below. */
const SUMMARY_ALLOWED_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'strong',
  'em',
  'u',
  's',
  'code',
  'a',
  'mark',
  'br',
]);

/** Allowed, but written without a closing tag and never pushed on the stack. */
const SUMMARY_VOID_TAGS = new Set(['br']);

/**
 * Spellings that mean something already on the allowlist. Normalising instead
 * of rejecting: a model that writes `<b>` rather than `<strong>` has produced
 * exactly the content asked for and differs only in a synonym, and failing a
 * 30-second call over that would be pedantry the user pays for. `h4`-`h6`
 * collapse to `h3` because the web editor's Heading extension is configured
 * for levels 1-3 only, so a level-4 heading has no node to parse into and
 * would vanish entirely — a flattened heading is strictly better than a
 * deleted one.
 */
const SUMMARY_TAG_ALIASES: Record<string, string> = {
  b: 'strong',
  i: 'em',
  del: 's',
  strike: 's',
  ins: 'u',
  h4: 'h3',
  h5: 'h3',
  h6: 'h3',
};

/**
 * Carry no meaning of their own: the tag is dropped and the CHILDREN ARE KEPT.
 * These show up when a model wraps its answer in a container out of habit, and
 * discarding the wrapper loses nothing at all.
 */
const SUMMARY_UNWRAP_TAGS = new Set([
  'div',
  'span',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'figure',
  'body',
  'html',
  'small',
  'font',
]);

/** Dropped outright — they have no text content to preserve. `hr` is here
 *  rather than on the allowlist specifically because of the mobile format
 *  lock (reason 2 above). */
const SUMMARY_DROP_TAGS = new Set(['hr', 'img', 'wbr']);

/** Dropped WITH their contents. Unwrapping these would splice a stylesheet or
 *  a script body into the document as visible prose. */
const SUMMARY_DROP_WITH_CONTENT = new Set(['script', 'style', 'template']);

/** Link schemes that may survive into stored markup. Anything else — most
 *  importantly `javascript:`, but also `data:` — makes the anchor unwrap to
 *  its own text, so the words survive and the URL does not. */
const SAFE_LINK_SCHEME = /^(?:https?:|mailto:)/i;

export type SanitizeSummaryHtmlResult =
  | { status: 'ok'; html: string }
  | { status: 'rejected'; reason: string };

/** Escape a text run for re-emission. `<` cannot appear here (the tokenizer
 *  splits on it), so the only real work is a bare `&` — one that does not
 *  already begin a well-formed entity, which must be escaped or it will be
 *  re-read as markup on the way back in. Valid entities are left alone so an
 *  `&mdash;` the model wrote stays an em dash instead of becoming literal
 *  text. */
function escapeSummaryText(text: string): string {
  return text
    .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{1,31};)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Find the `>` that ends the tag starting at `start`, skipping any `>` that
 * sits inside a quoted attribute value (`<a href="a?x>y">` is one tag, not
 * two). Returns -1 when the tag never closes, which is the truncation case.
 */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const ATTRIBUTE_PATTERN =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_PATTERN.exec(source)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[match[1].toLowerCase()] = value;
  }
  return attrs;
}

/**
 * Rebuild the attribute list for an allowed tag, keeping only what the two
 * editors actually read. Everything else is dropped SILENTLY rather than
 * rejected: attributes are decoration, and dropping `style="text-align:center"`
 * is the intended outcome (reason 2 above), not an error worth failing a call
 * over. Structure is what gets the strict treatment.
 *
 * Returns null when the tag itself should be unwrapped instead — currently
 * only an anchor whose href is missing or carries an unsafe scheme, where
 * keeping the words and dropping the link is better than either storing the
 * URL or losing the sentence.
 */
function summaryAttributesFor(
  tag: string,
  attrs: Record<string, string>,
): string | null {
  if (tag === 'a') {
    const href = (attrs.href ?? '').trim();
    if (!href || !SAFE_LINK_SCHEME.test(href)) return null;
    return ` href="${escapeSummaryText(href).replace(/"/g, '&quot;')}"`;
  }
  // TipTap's TaskList/TaskItem are addressed entirely through these two data
  // attributes on otherwise ordinary <ul>/<li> — both platforms parse them
  // (mobile's bundle carries TaskListBridge), so a checklist is one of the
  // few genuinely rich things a summary can safely use.
  if (tag === 'ul' && attrs['data-type'] === 'taskList') {
    return ' data-type="taskList"';
  }
  if (tag === 'li' && attrs['data-type'] === 'taskItem') {
    const checked = attrs['data-checked'] === 'true' ? 'true' : 'false';
    return ` data-type="taskItem" data-checked="${checked}"`;
  }
  return '';
}

/**
 * Validate and normalise the model's HTML against the allowlist above.
 *
 * Exported for direct unit testing — it is the security boundary of this
 * feature and the thing most worth pinning down without a provider in the
 * loop.
 */
export function sanitizeSummaryHtml(html: string): SanitizeSummaryHtmlResult {
  const source = typeof html === 'string' ? html : '';
  const out: string[] = [];
  /** Open elements. `emitted: false` marks one that was unwrapped, so its
   *  closing tag is swallowed too instead of appearing unmatched. */
  const stack: { name: string; emitted: boolean }[] = [];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      out.push(escapeSummaryText(source.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeSummaryText(source.slice(i, lt)));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) {
        return { status: 'rejected', reason: 'unterminated comment' };
      }
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = findTagEnd(source, lt + 2);
      if (end === -1) {
        return { status: 'rejected', reason: 'unterminated declaration' };
      }
      i = end + 1;
      continue;
    }

    const end = findTagEnd(source, lt + 1);
    if (end === -1) {
      return {
        status: 'rejected',
        reason: 'a tag is never closed, so the response was cut short',
      };
    }
    const inner = source.slice(lt + 1, end);
    i = end + 1;

    // ----- closing tag -----
    if (inner.startsWith('/')) {
      const rawName = inner.slice(1).trim().toLowerCase();
      const name = SUMMARY_TAG_ALIASES[rawName] ?? rawName;
      if (
        SUMMARY_DROP_TAGS.has(rawName) ||
        SUMMARY_VOID_TAGS.has(name) ||
        SUMMARY_DROP_WITH_CONTENT.has(rawName)
      ) {
        // A stray close for something that never opened an element here.
        continue;
      }
      const top = stack.pop();
      if (!top || top.name !== name) {
        return {
          status: 'rejected',
          reason: `closing </${rawName}> does not match the open element`,
        };
      }
      if (top.emitted) out.push(`</${name}>`);
      continue;
    }

    // ----- opening tag -----
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body.trim());
    if (!nameMatch) {
      return { status: 'rejected', reason: 'malformed tag' };
    }
    const rawName = nameMatch[1].toLowerCase();
    const name = SUMMARY_TAG_ALIASES[rawName] ?? rawName;

    if (SUMMARY_DROP_WITH_CONTENT.has(rawName)) {
      const closeIndex = source.toLowerCase().indexOf(`</${rawName}`, i);
      if (closeIndex === -1) {
        return {
          status: 'rejected',
          reason: `<${rawName}> is never closed`,
        };
      }
      const closeEnd = findTagEnd(source, closeIndex + 2);
      i = closeEnd === -1 ? source.length : closeEnd + 1;
      continue;
    }

    if (SUMMARY_DROP_TAGS.has(rawName)) continue;

    if (SUMMARY_UNWRAP_TAGS.has(rawName)) {
      if (!selfClosing) stack.push({ name: rawName, emitted: false });
      continue;
    }

    if (!SUMMARY_ALLOWED_TAGS.has(name)) {
      return {
        status: 'rejected',
        reason: `<${rawName}> is not allowed in a summary`,
      };
    }

    if (SUMMARY_VOID_TAGS.has(name)) {
      out.push(`<${name}>`);
      continue;
    }

    const attrs = summaryAttributesFor(name, parseAttributes(body));
    if (attrs === null) {
      // Unwrap (see summaryAttributesFor): keep the text, drop the element.
      if (!selfClosing) stack.push({ name, emitted: false });
      continue;
    }
    if (selfClosing) {
      out.push(`<${name}${attrs}></${name}>`);
      continue;
    }
    stack.push({ name, emitted: true });
    out.push(`<${name}${attrs}>`);
  }

  if (stack.length > 0) {
    return {
      status: 'rejected',
      reason: `<${stack[stack.length - 1].name}> is never closed, so the response was cut short`,
    };
  }

  const result = out.join('').trim();
  if (result.replace(/<[^>]*>/g, '').trim() === '') {
    return { status: 'rejected', reason: 'the summary has no text in it' };
  }
  return { status: 'ok', html: result };
}
