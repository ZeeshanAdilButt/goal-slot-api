import { createHash } from 'crypto';
import { CoachRole } from '@prisma/client';
import { buildCoachChatMessages, ContextBundle } from '../coach-ai.service';
import { LlmChatMessage } from '../../../shared/services/llm/llm.interface';
import {
  planScheduleBatch,
  repairMistypedIds,
  createDays,
  toMinutes,
  normalizeTitle,
} from '../../coach-proposals/schedule-batch-plan';
import { CoachProposedAction } from '../../coach-proposals/dto/apply-proposals.dto';
import { expandSplits, IssueSink } from '../proposal-guard';

/**
 * Shared machinery for the Coach schedule scenario evals: build the exact
 * prompt production sends for a given schedule and conversation, parse what
 * the model answered, and check properties of the proposal that do not
 * depend on wording.
 */

export interface EvalBlock {
  id: string;
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  category: string;
  goalId: string | null;
  isRecurring: boolean;
  /** Blocks sharing a seriesId are one recurring series (one edit changes all days). */
  seriesId?: string | null;
}

/** Stable fake uuid, so recordings stay valid across runs. */
export function fakeId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function block(
  title: string,
  days: number[],
  startTime: string,
  endTime: string,
  category = 'LEARNING',
  seriesId: string | null = null,
): EvalBlock[] {
  return days.map((d) => ({
    id: fakeId(`${title}|${d}|${startTime}`),
    title,
    dayOfWeek: d,
    startTime,
    endTime,
    category,
    goalId: null,
    isRecurring: true,
    seriesId,
  }));
}

/** Stable fake series id. */
export function seriesOf(label: string): string {
  return fakeId(`series|${label}`);
}

export function contextFor(blocks: EvalBlock[]): ContextBundle {
  return {
    habitsProfile: {
      why: 'Grow as an engineer without losing time with family and community.',
      religiousContext: 'NONE',
      sleepTargetHours: 7,
      bedtime: '22:00',
      wakeTime: '04:00',
      workEnvironment: 'remote',
    },
    recentCheckins: [],
    recentJournal: [],
    activeGoals: [],
    weekReflections: [],
    hoursByGoalThisWeek: [],
    recentTimeEntries: [],
    scheduleBlocks: blocks,
    acceptedInsights: [],
    noteTitles: [],
    weekKey: '2026-W45',
  } as unknown as ContextBundle;
}

export interface Turn {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
}

export function messagesFor(
  blocks: EvalBlock[],
  turns: Turn[],
  applyNotes: Record<string, string> = {},
): LlmChatMessage[] {
  return buildCoachChatMessages(
    contextFor(blocks),
    turns.map((t, i) => ({
      id: t.id ?? `m${i}`,
      role: t.role === 'user' ? CoachRole.USER : CoachRole.ASSISTANT,
      content: t.content,
    })),
    new Map(Object.entries(applyNotes)),
  );
}

export interface ParsedReply {
  text: string;
  prose: string;
  proposals: Array<{ summary?: string; actions: CoachProposedAction[] }>;
  /** Proposal blocks that were not strict JSON (comments, trailing commas). */
  nonStrict: number;
  /** Proposal blocks that could not be parsed even leniently. */
  unparseable: number;
}

export function parseReply(text: string): ParsedReply {
  const re = /```coach-proposal\s*([\s\S]*?)```/g;
  const proposals: ParsedReply['proposals'] = [];
  let nonStrict = 0;
  let unparseable = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1].trim();
    try {
      proposals.push(JSON.parse(raw));
      continue;
    } catch {
      nonStrict++;
    }
    try {
      const lenient = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"])\/\/.*$/gm, '$1')
        .replace(/,\s*([}\]])/g, '$1');
      proposals.push(JSON.parse(lenient));
    } catch {
      unparseable++;
    }
  }
  return {
    text,
    prose: text.replace(re, ' ').trim(),
    proposals,
    nonStrict,
    unparseable,
  };
}

export function allActions(r: ParsedReply): CoachProposedAction[] {
  return r.proposals.flatMap((p) =>
    Array.isArray(p.actions) ? p.actions : [],
  );
}

/**
 * The actions production would actually apply for this reply: splits
 * expanded the way the chat guard expands them, then one-character id typos
 * repaired. Every check works on these, so a model that uses
 * SPLIT_SCHEDULE_BLOCK is judged on the blocks it really produces.
 */
export function effectiveActions(
  r: ParsedReply,
  blocks: EvalBlock[],
): { actions: CoachProposedAction[]; expansionIssues: string[] } {
  const sink = new IssueSink();
  const expanded = expandSplits(allActions(r), blocks, sink);
  return {
    actions: repairMistypedIds(expanded, blocks).actions,
    expansionIssues: sink.model,
  };
}

/**
 * Checks that hold for ANY schedule proposal, whatever the scenario:
 * strict JSON, ids that exist with the title the action claims, and a batch
 * the real apply path would accept against this schedule.
 */
export function universalChecks(blocks: EvalBlock[], r: ParsedReply): string[] {
  const failures: string[] = [];
  if (r.unparseable)
    failures.push(`${r.unparseable} proposal block(s) are not JSON at all`);
  if (r.nonStrict)
    failures.push(
      `${r.nonStrict} proposal block(s) are not strict JSON (comments or trailing commas)`,
    );
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const { actions, expansionIssues } = effectiveActions(r, blocks);
  failures.push(
    ...expansionIssues.map((x) => `split could not be expanded: ${x}`),
  );
  actions.forEach((a, i) => {
    if (
      a.type === 'DELETE_SCHEDULE_BLOCK' ||
      a.type === 'UPDATE_SCHEDULE_BLOCK'
    ) {
      const target = a.id ? byId.get(a.id) : undefined;
      if (!target) {
        failures.push(
          `action ${i} ${a.type} uses id ${a.id ?? '(none)'} which is not in the context`,
        );
      } else if (
        a.expectedTitle &&
        normalizeTitle(a.expectedTitle) !== normalizeTitle(target.title)
      ) {
        failures.push(
          `action ${i} expectedTitle "${a.expectedTitle}" but id is "${target.title}"`,
        );
      } else if (!a.expectedTitle) {
        failures.push(`action ${i} ${a.type} has no expectedTitle`);
      }
    }
  });
  const plan = planScheduleBatch({ blocks, tombstones: new Set(), actions });
  for (const [i, issue] of plan.issues)
    failures.push(`would be refused at apply (action ${i}): ${issue}`);
  return failures;
}

/** Final schedule after applying the proposal's schedule actions, for assertions. */
export function applyInMemory(
  blocks: EvalBlock[],
  r: ParsedReply,
): EvalBlock[] {
  const state = new Map(blocks.map((b) => [b.id, { ...b }]));
  const { actions } = effectiveActions(r, blocks);
  for (const a of actions)
    if (a.type === 'DELETE_SCHEDULE_BLOCK' && a.id) state.delete(a.id);
  for (const a of actions) {
    if (a.type !== 'UPDATE_SCHEDULE_BLOCK' || !a.id) continue;
    const b = state.get(a.id);
    const p = (a.payload ?? {}) as Record<string, unknown>;
    if (!b) continue;
    // A series-scoped update changes every day of the series, and not its day.
    const series = p.updateScope === 'series' && b.seriesId;
    const targets = series
      ? [...state.values()].filter((x) => x.seriesId === b.seriesId)
      : [b];
    for (const t of targets) {
      Object.assign(t, {
        ...(typeof p.title === 'string' ? { title: p.title } : {}),
        ...(typeof p.startTime === 'string' ? { startTime: p.startTime } : {}),
        ...(typeof p.endTime === 'string' ? { endTime: p.endTime } : {}),
        ...(!series && typeof p.dayOfWeek === 'number'
          ? { dayOfWeek: p.dayOfWeek }
          : {}),
      });
    }
  }
  actions.forEach((a, i) => {
    if (a.type !== 'CREATE_SCHEDULE_BLOCK') return;
    const p = (a.payload ?? {}) as Record<string, unknown>;
    for (const d of createDays(p)) {
      state.set(`new-${i}-${d}`, {
        id: `new-${i}-${d}`,
        title: String(p.title),
        dayOfWeek: d,
        startTime: String(p.startTime),
        endTime: String(p.endTime),
        category: String(p.category ?? ''),
        goalId: null,
        isRecurring: true,
      });
    }
  });
  return [...state.values()];
}

export function idsOf(
  blocks: EvalBlock[],
  title: string,
  days?: number[],
): string[] {
  return blocks
    .filter((b) => normalizeTitle(b.title) === normalizeTitle(title))
    .filter((b) => !days || days.includes(b.dayOfWeek))
    .map((b) => b.id);
}

export function minutes(b: { startTime: string; endTime: string }): number {
  return toMinutes(b.endTime) - toMinutes(b.startTime);
}

export function touchedIds(r: ParsedReply, blocks: EvalBlock[]): Set<string> {
  const { actions } = effectiveActions(r, blocks);
  return new Set(actions.filter((a) => a.id).map((a) => a.id as string));
}

/** Rough prose check: does the reply claim to store sub-items inside a block? */
export function claimsBulletsInsideBlock(prose: string): boolean {
  const said =
    /(bullets?|topics|sub-?items|list|description|notes)[^.\n]{0,80}\b(inside|within|in (the|that|this) block|under (the|that|this) block)/i.test(
      prose,
    );
  const disclaimed =
    /(title only|only (hold|store|keep)s? a title|only (has|have) a title|no (description|notes|bullet)|can(not|'t) (store|hold|save|keep)|don'?t (support|store|hold))/i.test(
      prose,
    );
  return said && !disclaimed;
}
