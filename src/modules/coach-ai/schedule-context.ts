import { sanitizeSingleLine } from './safety/prompt-safety';

/**
 * Schedule views rendered into the Coach's chat context, on top of the flat
 * per-block list.
 *
 * The flat list ("id | title | day time") is what a model copies ids from,
 * but it is a poor thing to REASON over. In the conversation this was built
 * for, the user said "remove Reading & Labs on all weekdays". The block only
 * existed on Tuesday and Thursday; the model proposed five deletes with five
 * made-up ids, one per weekday, and before that had placed the replacement
 * blocks at a time it simply guessed. Both mistakes come from having to
 * reconstruct, from 57 scattered lines, facts that are trivial to state:
 * where every occurrence of a named block is, which days it is NOT on, how
 * long it runs, and where the free time is.
 */

export interface ContextBlock {
  id: string;
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HHMM = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fromMin(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function fmt12h(t: string): string {
  if (!HHMM.test(t)) return t;
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function normalize(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * One line per distinct block title: every occurrence with its own id, its
 * duration, and the days it does not occur on.
 */
export function renderScheduleByTitle(blocks: ContextBlock[]): string {
  if (blocks.length === 0) return '  (no schedule blocks yet)';
  const groups = new Map<string, ContextBlock[]>();
  for (const b of blocks) {
    const key = normalize(b.title);
    const g = groups.get(key) ?? [];
    g.push(b);
    groups.set(key, g);
  }
  const lines: string[] = [];
  for (const g of groups.values()) {
    g.sort(
      (a, b) =>
        a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
    );
    const durations = new Set(
      g.map((b) => toMin(b.endTime) - toMin(b.startTime)),
    );
    const durationText =
      durations.size === 1 ? fmtDuration([...durations][0]) : 'varies by day';
    const occurrences = g
      .map(
        (b) =>
          `${DAY_SHORT[b.dayOfWeek] ?? '?'} ${fmt12h(b.startTime)} to ${fmt12h(b.endTime)} id=${b.id}`,
      )
      .join('; ');
    const days = new Set(g.map((b) => b.dayOfWeek));
    const missing = [0, 1, 2, 3, 4, 5, 6].filter((d) => !days.has(d));
    const notOn = missing.length
      ? `not on: ${missing.map((d) => DAY_SHORT[d]).join(', ')}`
      : 'every day';
    lines.push(
      `  - "${sanitizeSingleLine(g[0].title)}" | ${g.length} occurrence${g.length === 1 ? '' : 's'} | ${durationText} each | ${occurrences} | ${notOn}`,
    );
  }
  return lines.join('\n');
}

/**
 * Free gaps of at least `minGap` minutes per day, inside the user's waking
 * window (stretched to cover any block outside it, so a 4:30 AM prayer block
 * does not make 4:30 to 7:00 look like the night).
 */
export function renderFreeTime(
  blocks: ContextBlock[],
  wake = '07:00',
  bed = '23:00',
  minGap = 15,
): string {
  const wakeMin = HHMM.test(wake) ? toMin(wake) : 7 * 60;
  let bedMin = HHMM.test(bed) ? toMin(bed) : 23 * 60;
  if (bedMin <= wakeMin) bedMin = 24 * 60 - 1; // bedtime after midnight
  const lines: string[] = [];
  for (let d = 0; d < 7; d++) {
    const day = blocks
      .filter(
        (b) =>
          b.dayOfWeek === d && HHMM.test(b.startTime) && HHMM.test(b.endTime),
      )
      .map((b) => [toMin(b.startTime), toMin(b.endTime)] as const)
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);
    const start = Math.min(wakeMin, ...day.map(([s]) => s));
    const end = Math.max(bedMin, ...day.map(([, e]) => e));
    const gaps: string[] = [];
    let cursor = start;
    for (const [s, e] of day) {
      if (s - cursor >= minGap) {
        gaps.push(
          `${fmt12h(fromMin(cursor))} to ${fmt12h(fromMin(s))} (${fmtDuration(s - cursor)})`,
        );
      }
      cursor = Math.max(cursor, e);
    }
    if (end - cursor >= minGap) {
      gaps.push(
        `${fmt12h(fromMin(cursor))} to ${fmt12h(fromMin(end))} (${fmtDuration(end - cursor)})`,
      );
    }
    lines.push(
      `  - ${DAY_SHORT[d]}: ${gaps.length ? gaps.join(', ') : 'no free time between wake and bedtime'}`,
    );
  }
  return lines.join('\n');
}

export interface ApplyNoteResult {
  index: number;
  type: string;
  ok: boolean;
  label?: string;
  error?: string;
  warning?: string;
  skipped?: boolean;
  alreadyDone?: boolean;
}

/**
 * What happened when the user clicked Apply on a proposal, as a note appended
 * to that assistant turn in the chat history. Without it the model's next
 * turn only sees its own proposal and the user's "it failed", and the
 * transcript shows what it then does: re-emit the same failing proposal with
 * a fresh guess. Every label and error is user-derived text (block titles),
 * so it goes through sanitizeSingleLine like every other stored value.
 */
export function renderApplyNote(meta: {
  outcome?: string;
  results?: ApplyNoteResult[];
}): string {
  const results = Array.isArray(meta.results) ? meta.results : [];
  if (results.length === 0) return '';
  const outcome =
    meta.outcome === 'refused'
      ? 'REFUSED before anything was written. Nothing in this proposal was applied; the schedule is unchanged.'
      : meta.outcome === 'applied'
        ? 'every action succeeded.'
        : meta.outcome === 'partial'
          ? 'PARTIAL. Some actions succeeded and some failed.'
          : 'every action FAILED.';
  const rows = results.slice(0, 40).map((r) => {
    const what = sanitizeSingleLine(r.label ?? r.type, 160);
    if (r.ok && r.alreadyDone)
      return `  ${r.index + 1}. ${what}: already done earlier`;
    if (r.ok && r.warning)
      return `  ${r.index + 1}. ${what}: done, with a caveat: ${sanitizeSingleLine(r.warning, 300)}`;
    if (r.ok) return `  ${r.index + 1}. ${what}: done`;
    if (r.skipped && r.error?.startsWith('Not applied, because another'))
      return `  ${r.index + 1}. ${what}: not attempted`;
    return `  ${r.index + 1}. ${what}: FAILED: ${sanitizeSingleLine(r.error ?? 'unknown error', 300)}`;
  });
  return [
    '',
    '',
    '[App note, not written by you: the user clicked Apply on the proposal above. Outcome: ' +
      outcome,
    ...rows,
    'The schedule in your context is the state AFTER this. If the user asks you to fix or retry, work from these results and the current schedule. Never re-send an action that failed for the same reason.]',
  ].join('\n');
}
