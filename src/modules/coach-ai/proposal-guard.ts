import { CoachProposedAction } from '../coach-proposals/dto/apply-proposals.dto';
import {
  fmt12h,
  normalizeTitle,
  PlanBlock,
  planScheduleBatch,
  repairMistypedIds,
  toMinutes,
} from '../coach-proposals/schedule-batch-plan';

/**
 * Checks a coach-proposal block against the user's real schedule BEFORE the
 * card is shown, so the user never gets a card the apply preflight would
 * refuse.
 *
 * Production, gpt-4o-mini, one multi-part request: an UPDATE on an id that
 * did not exist, two labs dropped on top of "Book", two weekend blocks moved
 * onto a Deep Reading block that had not moved yet and onto a new block in
 * the same batch, Sunday forgotten, and an invented 5 AM block on top of
 * Family Time. The preflight refused the batch, so nothing half-applied, but
 * the user got a dead card. This guard finds those problems while the model
 * can still fix them, and the chat stream asks it to (see
 * CoachAiService.finalizeProposal).
 *
 * It also expands SPLIT_SCHEDULE_BLOCK, a server-only shorthand: "split this
 * block, on every day it occurs, into these pieces of N minutes each". The
 * model names pieces and minutes; this file does the time arithmetic and
 * turns it into the standard UPDATE + CREATE actions, so the clients never
 * see a new action type.
 */

export interface GuardBlock extends PlanBlock {
  category?: string | null;
  goalId?: string | null;
}

export interface GuardResult {
  ok: boolean;
  /** Normalised proposal JSON (splits expanded, ids repaired); present when parseable. */
  json?: string;
  /** Concrete, model-readable problems (may name ids and action types). Empty when ok. */
  issues: string[];
  /**
   * The same problems for the USER: titles, days and times only, never an id
   * or an action type name. Shown when a proposal is withheld.
   */
  userIssues: string[];
  actions: CoachProposedAction[];
}

/** Collects each problem twice: once for the repair prompt, once for the user. */
export class IssueSink {
  readonly model: string[] = [];
  readonly user: string[] = [];
  add(model: string, user: string): void {
    this.model.push(model);
    this.user.push(user);
  }
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function loose(title: string): string {
  return normalizeTitle(title)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\band\b/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function looseTitleMatch(a: string, b: string): boolean {
  const x = loose(a);
  const y = loose(b);
  return (
    x === y ||
    (y.length >= 4 && x.includes(y)) ||
    (x.length >= 4 && y.includes(x))
  );
}

export function parseProposalJson(
  text: string,
): { summary?: string; actions: unknown[] } | null {
  const attempts = [
    text,
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"\\])\/\/.*$/gm, '$1')
      .replace(/,\s*([}\]])/g, '$1'),
  ];
  for (const t of attempts) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && Array.isArray(parsed.actions)) return parsed;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function fromMinutes(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

interface SplitPiece {
  title: string;
  minutes: number;
}

/**
 * SPLIT_SCHEDULE_BLOCK -> UPDATE (first piece keeps the original block, so
 * its id, goal link, series and logged time survive) + one CREATE per further
 * piece, laid back to back from the block's start. With allOccurrences, every
 * block with the same title is split the same way, and creates that land at
 * the same time on several days collapse into one daysOfWeek action.
 */
/**
 * Validate split pieces without dropping any silently: a piece that is
 * dropped is a lab missing from the card. Numeric strings ("30") are
 * coerced; anything else that is not a positive whole number of minutes, or
 * has no title, is reported.
 */
function readPieces(raw: unknown): { pieces: SplitPiece[]; bad: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const pieces: SplitPiece[] = [];
  const bad: string[] = [];
  list.forEach((x, k) => {
    const item = (x ?? {}) as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const minutes =
      typeof item.minutes === 'string' && /^\d+$/.test(item.minutes.trim())
        ? Number(item.minutes.trim())
        : item.minutes;
    if (
      !title ||
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes <= 0
    ) {
      bad.push(
        `piece ${k + 1} (${title ? `"${title}"` : 'no title'}, minutes ${JSON.stringify(item.minutes)})`,
      );
      return;
    }
    pieces.push({ title, minutes });
  });
  return { pieces, bad };
}

/**
 * Which block a SPLIT means. The id has to agree with expectedTitle: a
 * real id with the wrong title (Work's id with expectedTitle "Reading &
 * Labs") would otherwise split Work on every day it occurs. An unknown id is
 * accepted only when expectedTitle names exactly one title in the schedule.
 */
function resolveSplitAnchor(
  a: CoachProposedAction,
  blocks: GuardBlock[],
  byId: Map<string, GuardBlock>,
  sink: IssueSink,
): GuardBlock | undefined {
  const expected = a.expectedTitle
    ? normalizeTitle(a.expectedTitle)
    : undefined;
  const byIdHit = a.id ? byId.get(a.id) : undefined;
  if (byIdHit) {
    if (expected !== undefined && normalizeTitle(byIdHit.title) !== expected) {
      sink.add(
        `SPLIT_SCHEDULE_BLOCK id ${a.id} is "${byIdHit.title}", not "${a.expectedTitle}". Use the id of the block you mean.`,
        `A change named "${a.expectedTitle}" pointed at "${byIdHit.title}" instead.`,
      );
      return undefined;
    }
    return byIdHit;
  }
  const named = expected
    ? blocks.filter((b) => normalizeTitle(b.title) === expected)
    : [];
  if (named.length === 0) {
    sink.add(
      `SPLIT_SCHEDULE_BLOCK targets ${a.expectedTitle ? `"${a.expectedTitle}"` : `id ${a.id}`}, which is not in the schedule.`,
      a.expectedTitle
        ? `There is no block called "${a.expectedTitle}" in your schedule.`
        : 'A change pointed at a block that is not in your schedule.',
    );
    return undefined;
  }
  const p = (a.payload ?? {}) as Record<string, unknown>;
  if (p.allOccurrences === false && named.length > 1) {
    sink.add(
      `SPLIT_SCHEDULE_BLOCK on one occurrence of "${named[0].title}" needs that occurrence's id; it is on ${named.map((b) => `${DAY_SHORT[b.dayOfWeek]}=${b.id}`).join(', ')}.`,
      `"${named[0].title}" is on several days, and it was not clear which one to change.`,
    );
    return undefined;
  }
  return named[0];
}

export function expandSplits(
  actions: CoachProposedAction[],
  blocks: GuardBlock[],
  sink: IssueSink,
): CoachProposedAction[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const out: CoachProposedAction[] = [];
  for (const a of actions) {
    if ((a.type as string) !== 'SPLIT_SCHEDULE_BLOCK') {
      out.push(a);
      continue;
    }
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const anchor = resolveSplitAnchor(a, blocks, byId, sink);
    if (!anchor) continue;
    const { pieces, bad } = readPieces(p.pieces);
    if (bad.length > 0) {
      sink.add(
        `SPLIT_SCHEDULE_BLOCK on "${anchor.title}" has invalid pieces: ${bad.join(', ')}. Each piece needs a title and a whole number of minutes.`,
        `Some of the new pieces for "${anchor.title}" had no name or no valid length.`,
      );
      continue;
    }
    if (pieces.length === 0) {
      sink.add(
        `SPLIT_SCHEDULE_BLOCK on "${anchor.title}" has no pieces; give payload.pieces as [{ "title", "minutes" }].`,
        `The change to "${anchor.title}" did not say what to split it into.`,
      );
      continue;
    }
    const targets =
      p.allOccurrences === false
        ? [anchor]
        : blocks.filter(
            (b) => normalizeTitle(b.title) === normalizeTitle(anchor.title),
          );
    const creates = new Map<
      string,
      { payload: Record<string, unknown>; days: number[] }
    >();
    for (const t of targets) {
      const start = toMinutes(t.startTime);
      const window = toMinutes(t.endTime) - start;
      const total = pieces.reduce((s, x) => s + x.minutes, 0);
      if (total > window) {
        const fit = `${fmt12h(t.startTime)} to ${fmt12h(t.endTime)}`;
        sink.add(
          `The pieces for "${t.title}" on ${DAY_SHORT[t.dayOfWeek]} add up to ${total} minutes but the block is ${window} minutes (${fit}). Shorten the pieces, or ask the user where the extra time comes from.`,
          `The new pieces for "${t.title}" on ${DAY_SHORT[t.dayOfWeek]} add up to ${total} minutes, but it only runs ${window} minutes (${fit}).`,
        );
        continue;
      }
      let cursor = start;
      pieces.forEach((piece, k) => {
        const s = fromMinutes(cursor);
        const e = fromMinutes(cursor + piece.minutes);
        cursor += piece.minutes;
        if (k === 0) {
          out.push({
            type: 'UPDATE_SCHEDULE_BLOCK',
            id: t.id,
            expectedTitle: t.title,
            payload: {
              ...(piece.title !== t.title ? { title: piece.title } : {}),
              startTime: s,
              endTime: e,
            },
          });
          return;
        }
        const key = `${piece.title}|${s}|${e}`;
        const entry = creates.get(key) ?? {
          payload: {
            title: piece.title,
            startTime: s,
            endTime: e,
            category: t.category ?? 'LEARNING',
            ...(t.goalId ? { goalId: t.goalId } : {}),
          },
          days: [],
        };
        entry.days.push(t.dayOfWeek);
        creates.set(key, entry);
      });
    }
    for (const { payload, days } of creates.values()) {
      out.push({
        type: 'CREATE_SCHEDULE_BLOCK',
        payload:
          days.length === 1
            ? { ...payload, dayOfWeek: days[0] }
            : { ...payload, daysOfWeek: days.sort((x, y) => x - y) },
      });
    }
  }
  return out;
}

/**
 * Everything the guard can say about one proposal. Fixes what is safe to fix
 * silently (a missing expectedTitle, a one-character id typo, a split) and
 * reports the rest in words the model can act on.
 */
export function checkProposal(text: string, blocks: GuardBlock[]): GuardResult {
  const parsed = parseProposalJson(text);
  if (!parsed) {
    return {
      ok: false,
      issues: [
        'The proposal is not valid JSON with an "actions" array. Write strict JSON with no comments.',
      ],
      userIssues: ['The proposed change came out garbled.'],
      actions: [],
    };
  }
  const sink = new IssueSink();
  const raw = parsed.actions.filter(
    (a): a is CoachProposedAction => !!a && typeof a === 'object',
  );
  let actions = expandSplits(raw, blocks, sink);
  actions = repairMistypedIds(actions, blocks).actions;

  const byId = new Map(blocks.map((b) => [b.id, b]));
  actions = actions.map((a, i) => {
    if (
      a.type !== 'UPDATE_SCHEDULE_BLOCK' &&
      a.type !== 'DELETE_SCHEDULE_BLOCK'
    ) {
      return a;
    }
    const target = a.id ? byId.get(a.id) : undefined;
    if (!target) {
      // Loose on purpose: this only feeds the repair HINT ("these are the
      // real ids"), never what gets applied. The model often drops a
      // parenthetical suffix or writes "and" for "&".
      const named = a.expectedTitle
        ? blocks.filter((b) => looseTitleMatch(b.title, a.expectedTitle!))
        : [];
      sink.add(
        `Action ${i + 1} (${a.type}) uses id ${a.id ?? '(none)'}, which is not one of the user's blocks.` +
          (named.length
            ? ` "${named[0].title}" has these real ids: ${named.map((b) => `${DAY_SHORT[b.dayOfWeek]}=${b.id}`).join(', ')}.`
            : a.expectedTitle
              ? ` No block is titled "${a.expectedTitle}".`
              : ''),
        a.expectedTitle
          ? `A change to "${a.expectedTitle}" pointed at a block that is not in your schedule.`
          : 'A change pointed at a block that is not in your schedule.',
      );
      return a;
    }
    // A missing expectedTitle is filled in rather than reported: the id is
    // real, and the field exists to catch a WRONG title, not an absent one.
    return a.expectedTitle ? a : { ...a, expectedTitle: target.title };
  });

  const plan = planScheduleBatch({ blocks, tombstones: new Set(), actions });
  for (const [i, issue] of [...plan.issues].sort((x, y) => x[0] - y[0])) {
    // Planner messages speak in titles, days and times already; only the
    // trailing "Nothing was changed" (true of every withheld card) and any
    // "The Coach referenced a block id" aside are trimmed for the user.
    const plain = issue.replace(/ Nothing was (changed|deleted)\.$/, '');
    sink.add(
      `Action ${i + 1}: ${plain}`,
      plain
        .replace(/ The Coach referenced a block id that does not exist\./, '')
        .replace(/ with this id/, ''),
    );
  }

  const json = JSON.stringify(
    { ...(parsed.summary ? { summary: parsed.summary } : {}), actions },
    null,
    2,
  );
  return {
    ok: sink.model.length === 0,
    json,
    issues: sink.model,
    userIssues: sink.user,
    actions,
  };
}

/** The message that asks the model to fix its own proposal. */
export function repairInstruction(issues: string[]): string {
  return [
    '[App check, not the user: the proposal above would be REFUSED when applied, so it was not shown to the user. Problems:',
    ...issues.map((x) => `- ${x}`),
    'Reply with ONE corrected ```coach-proposal block that fixes every problem, using only ids and times from the context, then at most two short sentences. Use SPLIT_SCHEDULE_BLOCK for splitting a block into pieces so you do not have to compute times. Leave out any part you cannot do without guessing, and ask about it in one short question. If nothing in the request can be done safely, reply with no block at all and one short question.]',
  ].join('\n');
}
