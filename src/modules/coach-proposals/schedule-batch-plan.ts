import { CoachProposedAction } from './dto/apply-proposals.dto';

/**
 * Preflight for the schedule half of a Coach proposal batch.
 *
 * Why this exists. A real conversation went like this: the user asked to
 * replace "Reading & Labs (Core Engineering)" with two 30-minute blocks. The
 * Coach proposed DELETE <id> + CREATE + CREATE. The delete id matched no
 * block at all (the model made it up), the executor treated "not found" as
 * an idempotent success, the real block stayed where it was, and both creates
 * failed on a conflict. The card said the delete was applied and ended with
 * "Done". Every retry did the same thing.
 *
 * Two properties fix that class of bug for good, and both need the WHOLE
 * batch in view before anything is written:
 *
 *  1. Every DELETE/UPDATE_SCHEDULE_BLOCK id has to be one of the user's real
 *     blocks, or one the Coach already deleted for them on an earlier apply
 *     (a tombstone, see CoachProposalsService). An id that is neither never
 *     belonged to this user's schedule, and the batch is refused.
 *  2. The batch's END STATE has to be a valid schedule: no overlaps, no
 *     inverted ranges. Checking each action against the table as it stands
 *     mid-batch is order-dependent (a create listed before the delete that
 *     frees its slot fails) and cannot express a swap at all.
 *
 * If either property fails, nothing in the batch is applied. A replacement
 * that deletes the original and then cannot place the new blocks is worse
 * than no change: the user loses the block and gets nothing back.
 *
 * Pure on purpose: no Prisma, no Nest. The executor feeds it the user's
 * blocks and tombstones, and the Coach scenario evals reuse it to check that
 * a recorded model proposal would apply cleanly against the context it was
 * generated from.
 */

export interface PlanBlock {
  id: string;
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  seriesId?: string | null;
}

export interface SchedulePlan {
  /** Action index -> why it cannot be applied. Non-empty means refuse. */
  issues: Map<number, string>;
  /** DELETE actions whose target is already gone because an earlier apply removed it. */
  alreadyDeleted: Set<number>;
  /** Human label per schedule action ("delete "Book" Tue 9:00 AM to 11:00 AM"). */
  labels: Map<number, string>;
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HHMM = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function fmt12h(time: string): string {
  if (!HHMM.test(time)) return time;
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function describe(b: {
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}): string {
  return `"${b.title}" (${DAY_NAMES[b.dayOfWeek] ?? '?'} ${fmt12h(b.startTime)} to ${fmt12h(b.endTime)})`;
}

function shortLabel(b: {
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}): string {
  return `"${b.title}" ${DAY_SHORT[b.dayOfWeek] ?? '?'} ${fmt12h(b.startTime)} to ${fmt12h(b.endTime)}`;
}

/** Days a CREATE_SCHEDULE_BLOCK payload fans out to, same rule as the executor. */
export function createDays(payload: Record<string, unknown>): number[] {
  const raw = payload.daysOfWeek;
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6),
      ),
    );
  }
  return typeof payload.dayOfWeek === 'number' ? [payload.dayOfWeek] : [];
}

function rangeIssue(start: unknown, end: unknown): string | null {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  if (!HHMM.test(start) || !HHMM.test(end)) {
    return `Times must be 24-hour HH:mm (got ${start} to ${end}).`;
  }
  if (toMinutes(end) <= toMinutes(start)) {
    return toMinutes(end) < toMinutes(start)
      ? `${fmt12h(start)} to ${fmt12h(end)} runs past midnight. A block has to start and end on the same day, so split it into two blocks (one ending 11:59 PM, one starting 12:00 AM the next day).`
      : 'End time must be after start time.';
  }
  return null;
}

interface SimBlock extends PlanBlock {
  /** Index of the action that created or moved this block, if any. */
  touchedBy?: number;
  isNew?: boolean;
}

export function planScheduleBatch(input: {
  blocks: PlanBlock[];
  tombstones: Set<string>;
  actions: CoachProposedAction[];
}): SchedulePlan {
  const { blocks, tombstones, actions } = input;
  const issues = new Map<number, string>();
  const alreadyDeleted = new Set<number>();
  const labels = new Map<number, string>();

  const state = new Map<string, SimBlock>(blocks.map((b) => [b.id, { ...b }]));
  const original = new Map(blocks.map((b) => [b.id, b]));
  const deletedInBatch = new Set<string>();

  // Pass 1: deletes. They run first at apply time too, so the slots they
  // free are visible to everything after them regardless of listed order.
  actions.forEach((a, i) => {
    if (a.type !== 'DELETE_SCHEDULE_BLOCK') return;
    if (!a.id) {
      issues.set(i, 'This delete has no block id, so nothing was deleted.');
      return;
    }
    const target = original.get(a.id);
    if (target) {
      labels.set(i, `Delete ${shortLabel(target)}`);
      if (
        a.expectedTitle &&
        normalizeTitle(a.expectedTitle) !== normalizeTitle(target.title)
      ) {
        issues.set(
          i,
          `Skipped: this delete targets a different block than intended. Its id points at ${describe(target)}, not "${a.expectedTitle}". Nothing was deleted.`,
        );
        return;
      }
      state.delete(a.id);
      deletedInBatch.add(a.id);
      return;
    }
    labels.set(
      i,
      a.expectedTitle
        ? `Delete "${a.expectedTitle}"`
        : 'Delete a schedule block',
    );
    if (deletedInBatch.has(a.id)) return; // same id listed twice
    if (tombstones.has(a.id)) {
      alreadyDeleted.add(i);
      return;
    }
    issues.set(
      i,
      `${a.expectedTitle ? `"${a.expectedTitle}" with this id` : 'This block'} is not in your schedule, so nothing was deleted. The Coach referenced a block id that does not exist.`,
    );
  });

  // Pass 2: updates, in listed order, against the simulated state.
  actions.forEach((a, i) => {
    if (a.type !== 'UPDATE_SCHEDULE_BLOCK') return;
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const target = a.id ? state.get(a.id) : undefined;
    if (!target) {
      // Stale or unknown id. The executor has a strict re-match path for
      // these (resolveStaleScheduleBlock), so it is not refused here, but it
      // cannot be simulated either.
      labels.set(
        i,
        a.expectedTitle
          ? `Change "${a.expectedTitle}"`
          : 'Change a schedule block',
      );
      if (a.id && deletedInBatch.has(a.id)) {
        issues.set(
          i,
          'This proposal deletes this block and also changes it. Nothing was changed.',
        );
      }
      return;
    }
    labels.set(i, `Change ${shortLabel(target)}`);
    if (
      a.expectedTitle &&
      normalizeTitle(a.expectedTitle) !== normalizeTitle(target.title)
    ) {
      issues.set(
        i,
        `Skipped: this change targets a different block than intended. Its id points at ${describe(target)}, not "${a.expectedTitle}". Nothing was changed.`,
      );
      return;
    }
    const nextStart =
      typeof p.startTime === 'string' ? p.startTime : target.startTime;
    const nextEnd = typeof p.endTime === 'string' ? p.endTime : target.endTime;
    const bad = rangeIssue(nextStart, nextEnd);
    if (bad) {
      issues.set(i, bad);
      return;
    }
    const seriesScope = p.updateScope === 'series' && target.seriesId;
    const affected = seriesScope
      ? [...state.values()].filter((b) => b.seriesId === target.seriesId)
      : [target];
    for (const b of affected) {
      if (!seriesScope && typeof p.dayOfWeek === 'number')
        b.dayOfWeek = p.dayOfWeek;
      if (typeof p.startTime === 'string') b.startTime = p.startTime;
      if (typeof p.endTime === 'string') b.endTime = p.endTime;
      if (typeof p.title === 'string') b.title = p.title;
      if (
        typeof p.startTime === 'string' ||
        typeof p.endTime === 'string' ||
        typeof p.dayOfWeek === 'number'
      ) {
        b.touchedBy = i;
      }
    }
  });

  // Pass 3: creates.
  actions.forEach((a, i) => {
    if (a.type !== 'CREATE_SCHEDULE_BLOCK') return;
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const days = createDays(p);
    const title = typeof p.title === 'string' ? p.title : 'New block';
    if (typeof p.startTime === 'string' && typeof p.endTime === 'string') {
      const dayText =
        days.length === 1
          ? DAY_SHORT[days[0]]
          : days.map((d) => DAY_SHORT[d]).join(', ');
      labels.set(
        i,
        `Add "${title}" ${dayText} ${fmt12h(p.startTime)} to ${fmt12h(p.endTime)}`,
      );
    } else {
      labels.set(i, `Add "${title}"`);
    }
    if (days.length === 0) {
      issues.set(i, 'This new block has no day, so it was not added.');
      return;
    }
    if (typeof p.startTime !== 'string' || typeof p.endTime !== 'string') {
      issues.set(
        i,
        'This new block has no start or end time, so it was not added.',
      );
      return;
    }
    const bad = rangeIssue(p.startTime, p.endTime);
    if (bad) {
      issues.set(i, bad);
      return;
    }
    days.forEach((d) => {
      const identical = [...state.values()].find(
        (b) =>
          b.dayOfWeek === d &&
          b.startTime === p.startTime &&
          b.endTime === p.endTime &&
          b.title === title,
      );
      if (identical) return; // re-apply: the executor reuses it
      const id = `new:${i}:${d}`;
      state.set(id, {
        id,
        title,
        dayOfWeek: d,
        startTime: p.startTime as string,
        endTime: p.endTime as string,
        touchedBy: i,
        isNew: true,
      });
    });
  });

  // Final-state conflict check. Only blocks this batch moved or added can be
  // the cause of a NEW overlap; pre-existing overlaps are not this batch's
  // problem and must not block it.
  const final = [...state.values()];
  for (const b of final) {
    if (b.touchedBy === undefined || issues.has(b.touchedBy)) continue;
    const s = toMinutes(b.startTime);
    const e = toMinutes(b.endTime);
    const clash = final.find(
      (o) =>
        o.id !== b.id &&
        o.dayOfWeek === b.dayOfWeek &&
        s < toMinutes(o.endTime) &&
        e > toMinutes(o.startTime) &&
        // An overlap between two touched blocks is reported once, on the
        // later action, not twice.
        !(o.touchedBy !== undefined && o.touchedBy > b.touchedBy!),
    );
    if (clash) {
      const where = `${DAY_NAMES[b.dayOfWeek]} ${fmt12h(b.startTime)} to ${fmt12h(b.endTime)}`;
      const other = clash.isNew
        ? `${describe(clash)}, which this same proposal also adds`
        : describe(clash);
      issues.set(
        b.touchedBy,
        `${where} would overlap ${other}. Nothing was changed.`,
      );
    }
  }

  return { issues, alreadyDeleted, labels };
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Repair a schedule-block id the model copied with a typo.
 *
 * Seen in the scenario evals: a model emitted
 * `dd271118-e27e-4595-a9e4-dcd66a7dc84`, one character short of the real id,
 * with `expectedTitle: "Community Time"`. Refusing the batch is safe but
 * leaves the user with a dead card for a slip a human would never make.
 *
 * Deliberately narrow, so it can never turn a made-up id into a real one:
 *   - only ids that match none of the user's blocks and no tombstone (a
 *     re-applied delete whose block is gone must never be "repaired" onto a
 *     sibling occurrence with the same title);
 *   - only when the action carries expectedTitle;
 *   - exactly ONE of the user's blocks has that title (case/whitespace
 *     insensitive) AND an id within 2 edits of the one given.
 * Two random uuids differ in ~34 of 36 characters, so a fabricated id is
 * nowhere near any real one; that is the case the preflight still refuses.
 */
export function repairMistypedIds(
  actions: CoachProposedAction[],
  blocks: PlanBlock[],
  /** Ids a tombstone shows were deleted earlier: gone on purpose, never "mistyped". */
  tombstones: Set<string> = new Set(),
): { actions: CoachProposedAction[]; repaired: Map<number, string> } {
  const known = new Set(blocks.map((b) => b.id));
  const repaired = new Map<number, string>();
  const out = actions.map((a, i) => {
    if (
      (a.type !== 'DELETE_SCHEDULE_BLOCK' &&
        a.type !== 'UPDATE_SCHEDULE_BLOCK') ||
      !a.id ||
      known.has(a.id) ||
      tombstones.has(a.id) ||
      !a.expectedTitle
    ) {
      return a;
    }
    const title = normalizeTitle(a.expectedTitle);
    const near = blocks.filter(
      (b) =>
        normalizeTitle(b.title) === title && editDistance(b.id, a.id!) <= 2,
    );
    if (near.length !== 1) return a;
    repaired.set(i, near[0].id);
    return { ...a, id: near[0].id };
  });
  return { actions: out, repaired };
}

export function isScheduleAction(a: CoachProposedAction): boolean {
  return (
    a.type === 'CREATE_SCHEDULE_BLOCK' ||
    a.type === 'UPDATE_SCHEDULE_BLOCK' ||
    a.type === 'DELETE_SCHEDULE_BLOCK'
  );
}
