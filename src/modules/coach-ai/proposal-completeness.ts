import { CoachProposedAction } from '../coach-proposals/dto/apply-proposals.dto';
import { fmt12h, normalizeTitle } from '../coach-proposals/schedule-batch-plan';
import type { GuardBlock } from './proposal-guard';
import { loose, looseMessage, relatedTitles } from './title-match';

/**
 * Completeness checks on a schedule proposal: is it VALID but INCOMPLETE or
 * WRONG? Production, 2026-11-06, newest build: a 20-part weekly restructure
 * produced a card that applied exactly as shown and still covered about 9 of
 * the 20 asks:
 *
 *  - "Book" is ONE series on Tue to Fri; the card renamed only Tuesday's id,
 *    splitting the series (Tue "Study", Wed to Fri "Book"). Same for
 *    "Community Time" Mon to Fri, of which only Friday was renamed.
 *  - Saturday's "Deep Reading" (7 AM to 1 PM) was turned into "Soft Skills
 *    Lab" so new blocks could be created after it, while the labs the user
 *    wanted inside "Reading & Labs" were never made.
 *  - One goal id was copied onto every created block, including one with
 *    nothing to do with it.
 *
 * Every one of those cards was valid, so the validity guard let them through.
 * These checks are deterministic and keyed to the user's own words: what the
 * user named decides what a card must cover.
 */

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES: Array<[number, RegExp]> = [
  [0, /\bsunday?s?\b/i],
  [1, /\b(monday|mon)s?\b/i],
  [2, /\b(tuesday|tues|tue)s?\b/i],
  [3, /\b(wednesday|weds|wed)s?\b/i],
  [4, /\b(thursday|thurs|thur|thu)s?\b/i],
  [5, /\b(friday|fri)s?\b/i],
  [6, /\bsaturday?s?\b/i],
];

export type IssueAdd = (model: string, user: string) => void;

/** Text with quoted spans removed ("Talking About Weekdays" is a title, not a day word). */
function withoutQuotes(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”/g, ' ');
}

/**
 * Days a piece of the user's text restricts a change to; empty when it names
 * none. `ignore` are titles in play ("Dev Weekends" is a name, not a limit to
 * weekends), removed before reading.
 */
function daysIn(text: string, ignore: string[] = []): Set<number> {
  let t = withoutQuotes(text);
  for (const title of ignore) {
    if (title.length < 3) continue;
    t = t.split(new RegExp(escapeRe(title), 'ig')).join(' ');
  }
  const days = new Set<number>();
  for (const [d, re] of DAY_NAMES) if (re.test(t)) days.add(d);
  if (/\bweekdays?\b/i.test(t)) [1, 2, 3, 4, 5].forEach((d) => days.add(d));
  if (/\bweekends?\b/i.test(t)) [0, 6].forEach((d) => days.add(d));
  return days;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The user's message as sentences / list items, each judged on its own. */
export function segments(message: string): string[] {
  return message
    .split(/\n+|(?<=[.!?])\s+|\s[-•*]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mentions(segment: string, title: string): boolean {
  const t = loose(title);
  return t.length >= 3 && looseMessage(segment).includes(t);
}

/**
 * Which days the user limited a change to one block to, or null when they did
 * not. Read per list item: in "For Community Time at 4 pm, replace it with X.
 * On weekends replace Community Time with X." only the second item mentions
 * days, so the first still means every day the block occurs.
 */
export function daysLimitFor(
  message: string,
  title: string,
  ignore: string[] = [],
): Set<number> | null {
  const segs = segments(message).filter((s) => mentions(s, title));
  if (segs.length === 0) {
    const all = daysIn(message, ignore);
    return all.size > 0 ? all : null;
  }
  const limit = new Set<number>();
  for (const s of segs) {
    const d = daysIn(s, ignore);
    if (d.size === 0) return null;
    d.forEach((x) => limit.add(x));
  }
  return limit;
}

function dayRange(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  const contiguous =
    d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return contiguous
    ? `${DAY_SHORT[d[0]]} to ${DAY_SHORT[d[d.length - 1]]}`
    : d.map((x) => DAY_SHORT[x]).join(', ');
}

function payloadOf(a: CoachProposedAction): Record<string, unknown> {
  return (a.payload ?? {}) as Record<string, unknown>;
}

/** An UPDATE that changes a title or a time (not just a goal link or category). */
function changesTitleOrTime(a: CoachProposedAction, t: GuardBlock): boolean {
  const p = payloadOf(a);
  return (
    (typeof p.title === 'string' &&
      normalizeTitle(p.title) !== normalizeTitle(t.title)) ||
    (typeof p.startTime === 'string' && p.startTime !== t.startTime) ||
    (typeof p.endTime === 'string' && p.endTime !== t.endTime)
  );
}

function isSeriesScoped(a: CoachProposedAction): boolean {
  return payloadOf(a).updateScope === 'series';
}

/** Ids an UPDATE or DELETE in this proposal reaches, a series-scoped update reaching its whole series. */
function touchedIds(
  actions: CoachProposedAction[],
  blocks: GuardBlock[],
): Set<string> {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const touched = new Set<string>();
  for (const a of actions) {
    if (
      (a.type !== 'UPDATE_SCHEDULE_BLOCK' &&
        a.type !== 'DELETE_SCHEDULE_BLOCK') ||
      !a.id
    ) {
      continue;
    }
    touched.add(a.id);
    const t = byId.get(a.id);
    if (
      a.type === 'UPDATE_SCHEDULE_BLOCK' &&
      isSeriesScoped(a) &&
      t?.seriesId
    ) {
      blocks
        .filter((b) => b.seriesId === t.seriesId)
        .forEach((b) => touched.add(b.id));
    }
  }
  return touched;
}

function samePayload(a: CoachProposedAction, b: CoachProposedAction): boolean {
  const norm = (x: CoachProposedAction) =>
    JSON.stringify(
      Object.entries(payloadOf(x))
        .filter(([k]) => k !== 'updateScope')
        .sort(([x1], [x2]) => x1.localeCompare(x2)),
    );
  return norm(a) === norm(b);
}

export interface CompletenessResult {
  actions: CoachProposedAction[];
  /** Plain sentences for the user about what was widened, shown with the card. */
  notes: string[];
}

/**
 * Sibling completeness for UPDATEs (title or time) and DELETEs.
 *
 * Same series, user named no limiting days: an UPDATE that reaches only some
 * days of a series is rewritten to ONE updateScope "series" action, since a
 * plain per-day edit splits the series (Tue "Study", Wed to Fri "Book"). The
 * card is still shown for approval and a note says how many days it covers.
 * DELETEs are never widened (an unseen extra delete is worse than a missing
 * one): they are reported, with the exact ids, like every case the guard
 * cannot settle from the user's words alone.
 *
 * Same title and same slot in ANOTHER series (weekend "Community Time" next to
 * the weekday series): reported, with the ids, never widened.
 *
 * If the user limited the change to named days ("only Tuesday"), nothing is
 * widened and nothing is reported for the days left out.
 */
export function enforceSiblingCompleteness(
  input: CoachProposedAction[],
  blocks: GuardBlock[],
  message: string,
  add: IssueAdd,
): CompletenessResult {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let actions = [...input];
  const notes: string[] = [];
  const titlesInPlay = [
    ...new Set(
      input.flatMap((a) => {
        const title = payloadOf(a).title;
        const t = a.id ? byId.get(a.id)?.title : undefined;
        return [
          ...(typeof title === 'string' ? [title] : []),
          ...(t ? [t] : []),
        ];
      }),
    ),
  ];
  const inLimit = (limit: Set<number> | null, b: GuardBlock) =>
    !limit || limit.has(b.dayOfWeek);

  // 1. Upgrade partial same-series edits to one series-scoped action.
  const seriesIds = new Set(
    actions
      .map((a) => (a.id ? byId.get(a.id)?.seriesId : undefined))
      .filter((s): s is string => !!s),
  );
  for (const seriesId of seriesIds) {
    const members = blocks.filter((b) => b.seriesId === seriesId);
    if (members.length < 2) continue;
    const memberIds = new Set(members.map((b) => b.id));
    const group = actions.filter(
      (a) =>
        a.type === 'UPDATE_SCHEDULE_BLOCK' &&
        a.id &&
        memberIds.has(a.id) &&
        changesTitleOrTime(a, byId.get(a.id)!),
    );
    if (group.length === 0 || group.some(isSeriesScoped)) continue;
    const touched = touchedIds(actions, blocks);
    if (members.every((m) => touched.has(m.id))) continue;
    const first = byId.get(group[0].id!)!;
    const limit = daysLimitFor(message, first.title, titlesInPlay);
    if (limit && !members.every((m) => limit.has(m.dayOfWeek))) continue;
    if (
      group.some((a) => typeof payloadOf(a).dayOfWeek === 'number') ||
      !group.every((a) => samePayload(a, group[0]))
    ) {
      continue; // reported below instead
    }
    const upgraded: CoachProposedAction = {
      ...group[0],
      expectedTitle: group[0].expectedTitle ?? first.title,
      payload: { ...payloadOf(group[0]), updateScope: 'series' },
    };
    actions = actions
      .filter((a) => a === group[0] || !group.includes(a))
      .map((a) => (a === group[0] ? upgraded : a));
    const wasDays = group.map((a) => byId.get(a.id!)!.dayOfWeek);
    notes.push(
      `"${first.title}" is one recurring block, so this change covers all ${members.length} days (${dayRange(members.map((m) => m.dayOfWeek))}), not only ${dayRange(wasDays)}.`,
    );
  }

  // 2. Report what is still partial.
  const touched = touchedIds(actions, blocks);
  const sameGroupReported = new Set<string>();
  for (const a of actions) {
    if (
      (a.type !== 'UPDATE_SCHEDULE_BLOCK' &&
        a.type !== 'DELETE_SCHEDULE_BLOCK') ||
      !a.id
    ) {
      continue;
    }
    const t = byId.get(a.id);
    if (!t) continue;
    const isDelete = a.type === 'DELETE_SCHEDULE_BLOCK';
    if (!isDelete && !changesTitleOrTime(a, t)) continue;
    const limit = daysLimitFor(message, t.title, titlesInPlay);
    const verb = isDelete ? 'deletes' : 'changes';

    // Same series.
    if (t.seriesId && !isSeriesScoped(a)) {
      const all = blocks.filter((b) => b.seriesId === t.seriesId);
      const left = all.filter(
        (b) => b.id !== t.id && !touched.has(b.id) && inLimit(limit, b),
      );
      if (left.length > 0) {
        const ids = left
          .map((b) => `${DAY_SHORT[b.dayOfWeek]}=${b.id}`)
          .join(', ');
        const wholeSeries = all.every((b) => inLimit(limit, b));
        const fix = isDelete
          ? `Add one DELETE_SCHEDULE_BLOCK (expectedTitle "${t.title}") for each of: ${ids}, or leave the delete out and ask which days the user means.`
          : wholeSeries && typeof payloadOf(a).dayOfWeek !== 'number'
            ? `Use ONE UPDATE_SCHEDULE_BLOCK with payload.updateScope "series" on id=${t.id} instead of one action per day.`
            : `Add the same change (with expectedTitle) for each of: ${ids}, or ask which days the user means.`;
        add(
          `This proposal ${verb} "${t.title}" on ${DAY_SHORT[t.dayOfWeek]} only, but it is one series on ${dayRange(all.map((b) => b.dayOfWeek))} and the user${limit ? ' named other days too' : ' did not limit it to named days'}. FIX: ${fix}`,
          `"${t.title}" runs on ${dayRange(all.map((b) => b.dayOfWeek))}, but this ${isDelete ? 'removal' : 'change'} only covered ${DAY_SHORT[t.dayOfWeek]}.`,
        );
      }
    }

    // Same title and slot in another series.
    const key = `${normalizeTitle(t.title)}|${t.startTime}|${t.endTime}`;
    if (sameGroupReported.has(key)) continue;
    const others = blocks.filter(
      (b) =>
        b.id !== t.id &&
        normalizeTitle(b.title) === normalizeTitle(t.title) &&
        b.startTime === t.startTime &&
        b.endTime === t.endTime &&
        !(t.seriesId && b.seriesId === t.seriesId) &&
        !touched.has(b.id) &&
        inLimit(limit, b),
    );
    if (others.length === 0) continue;
    sameGroupReported.add(key);
    const list = others
      .map((b) => `${DAY_SHORT[b.dayOfWeek]}=${b.id}`)
      .join(', ');
    add(
      `This proposal ${verb} "${t.title}" (${DAY_SHORT[t.dayOfWeek]} ${fmt12h(t.startTime)} to ${fmt12h(t.endTime)}), but the same block, same time, is also on ${list} and nothing in the proposal touches it. The user did not limit the change to named days. FIX: ${isDelete ? 'add one DELETE_SCHEDULE_BLOCK (with expectedTitle) per id' : 'add one UPDATE_SCHEDULE_BLOCK (with expectedTitle) per id, with the same payload'}, or leave this part out and ask which days the user means.`,
      `"${t.title}" is also on ${others.map((b) => DAY_SHORT[b.dayOfWeek]).join(', ')} at the same time, and the change did not cover ${others.length === 1 ? 'it' : 'them'}.`,
    );
  }
  return { actions, notes };
}

const RENAME_WORDS =
  /\b(rename[sd]?|re-?title[sd]?|re-?label(?:l?ed)?|call(?:ed)? (?:it|that|this|them)|name[sd]? (?:it|that|this)|replace[sd]?|make (?:it|that|this)|turn(?:ed)? (?:it|that|this) into|instead of|change (?:it|that|this)? ?to)\b/i;

/**
 * An UPDATE that renames a block to an unrelated title. The block keeps its
 * goal link, series and logged time, so "Deep Reading" becoming "Soft Skills
 * Lab" so that new blocks fit after it is the wrong move: a new block, or a
 * SPLIT inside the right block, is. Fine when the user asked to rename that
 * block: some list item names the block and says rename / replace / call it,
 * or names the new title.
 *
 * Runs on the model's own actions, before SPLIT expansion: a split's first
 * piece is the sanctioned way to retitle, and carries whatever name the user
 * gave the piece.
 */
export function flagUnrelatedRenames(
  actions: CoachProposedAction[],
  blocks: GuardBlock[],
  message: string,
  add: IssueAdd,
): void {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const segs = segments(message);
  actions.forEach((a, i) => {
    if (a.type !== 'UPDATE_SCHEDULE_BLOCK' || !a.id) return;
    const t = byId.get(a.id);
    const next = payloadOf(a).title;
    if (!t || typeof next !== 'string') return;
    if (normalizeTitle(next) === normalizeTitle(t.title)) return;
    if (relatedTitles(next, t.title)) return;
    const asked = segs.some(
      (s) =>
        mentions(s, t.title) && (RENAME_WORDS.test(s) || mentions(s, next)),
    );
    if (asked) return;
    add(
      `Action ${i + 1} turns "${t.title}" (${DAY_SHORT[t.dayOfWeek]} ${fmt12h(t.startTime)} to ${fmt12h(t.endTime)}) into "${next}", an unrelated title, and the user did not ask to rename it. The block keeps its goal link and logged time, so this turns it into something else. FIX: leave "${t.title}" as it is; create a new block in a free slot, or use SPLIT_SCHEDULE_BLOCK inside the block the new part belongs to.`,
      `"${t.title}" (${DAY_SHORT[t.dayOfWeek]}) would turn into "${next}", which you did not ask for.`,
    );
  });
}

export interface GoalRef {
  id: string;
  title: string;
}

/**
 * Drop a goalId the model put on a CREATE unless the goal's title is related
 * to the block's title or the user's message names that goal. Production: one
 * goal (Core Engineering Study) copied onto every create, including
 * "Founder Interviews Prep per project", so time logged there counted toward
 * the wrong goal. Unlinked is recoverable (the user can say which goal);
 * wrongly linked quietly corrupts the hours. Ids this check cannot judge
 * (a $ref to a goal created in the same card, or an id that is not one of the
 * user's goals) are left to the apply path.
 */
export function sanitizeGoalLinks(
  actions: CoachProposedAction[],
  goals: GoalRef[],
  message: string,
): { actions: CoachProposedAction[]; unlinked: string[] } {
  const unlinked: string[] = [];
  const byId = new Map(goals.map((g) => [g.id, g]));
  const text = looseMessage(message);
  const out = actions.map((a) => {
    if (a.type !== 'CREATE_SCHEDULE_BLOCK') return a;
    const p = payloadOf(a);
    const goalId = p.goalId;
    if (typeof goalId !== 'string') return a;
    const goal = byId.get(goalId);
    if (!goal) return a;
    const title = typeof p.title === 'string' ? p.title : '';
    const named =
      loose(goal.title).length >= 4 && text.includes(loose(goal.title));
    if (named || (title && relatedTitles(title, goal.title))) return a;
    const rest = { ...p };
    delete rest.goalId;
    if (title) unlinked.push(title);
    return { ...a, payload: rest };
  });
  return { actions: out, unlinked };
}
