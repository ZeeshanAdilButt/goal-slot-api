import { CoachRole } from '@prisma/client';
import {
  buildCoachChatMessages,
  CoachAiService,
  NO_NEW_CHANGE,
  NOTHING_CHANGED,
} from '../coach-ai.service';
import { checkProposal } from '../proposal-guard';
import { guardProposalStream, stripCoverageClaims } from '../proposal-stream';
import { renderApplyNote } from '../schedule-context';
import { renderUnmatchedQuotedTitles } from '../quoted-titles';
import {
  countAsks,
  parseReview,
  renderNotCovered,
  shouldReview,
  simulateCard,
} from '../proposal-review';
import { contextFor, EvalBlock, idsOf } from '../__evals__/harness';
import { REAL_WEEK } from '../__evals__/scenarios';
import { LlmStreamChunk } from '../../../shared/services/llm/llm.interface';
import { CoachProposedAction } from '../../coach-proposals/dto/apply-proposals.dto';
import {
  APPLY_RESULTS,
  CORE_GOAL,
  FOLLOW_UP,
  ORIGINAL_LEAD_IN,
  ORIGINAL_TRAILING,
  productionCard,
  USER_MESSAGE,
} from './fixtures/production-2026-11-06';

/**
 * Replay of the production card of 2026-11-06 (see the fixture): a card that
 * was VALID and applied exactly as shown, yet covered about 9 of 20 asks.
 * Each describe block is one numbered failure from that conversation. Fake
 * providers only; no model is ever called.
 */

const READING = 'Reading & Labs (Core Engineering)';
const id = (title: string, day: number) => idsOf(REAL_WEEK, title, [day])[0];
const ctx = { userMessage: USER_MESSAGE, goals: [CORE_GOAL] };

const update = (
  title: string,
  day: number,
  payload: Record<string, unknown>,
): CoachProposedAction => ({
  type: 'UPDATE_SCHEDULE_BLOCK',
  id: id(title, day),
  expectedTitle: title,
  payload,
});
const body = (actions: CoachProposedAction[]) =>
  JSON.stringify({ summary: 's', actions });

const at = (blocks: EvalBlock[], title: string, days: number[]) =>
  blocks
    .filter((b) => b.title === title && days.includes(b.dayOfWeek))
    .map((b) => b.dayOfWeek)
    .sort();

describe('production card replay', () => {
  const card = productionCard();
  const r = checkProposal(JSON.stringify(card), REAL_WEEK, ctx);

  describe('1. series not used, siblings left behind', () => {
    it('rewrites the Book and Community Time renames to one series action each', () => {
      const series = r.actions.filter(
        (a) => (a.payload as any)?.updateScope === 'series',
      );
      expect(series.map((a) => a.expectedTitle).sort()).toEqual([
        'Book',
        'Community Time',
      ]);
      // One action per series, not one per day.
      expect(r.actions.filter((a) => a.expectedTitle === 'Book')).toHaveLength(
        1,
      );
    });

    it('leaves the whole series renamed, not split', () => {
      const after = simulateCard(REAL_WEEK, r.actions);
      expect(at(after as EvalBlock[], 'Study', [2, 3, 4, 5])).toEqual([
        2, 3, 4, 5,
      ]);
      expect(at(after as EvalBlock[], 'Book', [2, 3, 4, 5])).toEqual([]);
      expect(
        at(after as EvalBlock[], 'Dev Weekends', [0, 1, 2, 3, 4, 5, 6]),
      ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('says how many days the card covers, in the summary the card shows', () => {
      expect(r.widened).toEqual(
        expect.arrayContaining([
          expect.stringContaining('all 4 days (Tue to Fri), not only Tue'),
          expect.stringContaining('all 5 days (Mon to Fri), not only Fri'),
        ]),
      );
      const summary = JSON.parse(r.json!).summary as string;
      expect(summary).toContain('all 4 days (Tue to Fri), not only Tue');
      expect(summary).toContain('all 5 days (Mon to Fri), not only Fri');
      // The model's own summary is kept, after the widening.
      expect(summary).toContain("Restructure 'Deep Reading'");
    });

    it('does not widen when the user limits the change to a named day', () => {
      const only = checkProposal(
        body([update('Book', 2, { title: 'Study' })]),
        REAL_WEEK,
        { userMessage: 'Rename Book to Study, only on Tuesday' },
      );
      expect(only.ok).toBe(true);
      expect(only.actions).toHaveLength(1);
      expect((only.actions[0].payload as any).updateScope).toBeUndefined();
      expect(only.widened).toBeUndefined();
    });

    it('still widens to the series when the limit covers every day of it', () => {
      const weekdays = checkProposal(
        body([update('Community Time', 5, { title: 'Dev Weekends' })]),
        REAL_WEEK,
        { userMessage: 'Rename weekday Community Time to Dev Weekends' },
      );
      expect((weekdays.actions[0].payload as any).updateScope).toBe('series');
      expect(weekdays.ok).toBe(true); // weekend Community Time was not asked for
    });

    it('asks for the other series with the same title and slot, with their ids', () => {
      const weekdayOnly = checkProposal(
        body([update('Community Time', 5, { title: 'Dev Weekends' })]),
        REAL_WEEK,
        { userMessage: 'Rename Community Time at 4 pm to Dev Weekends' },
      );
      expect(weekdayOnly.ok).toBe(false);
      const text = weekdayOnly.issues.join('\n');
      expect(text).toContain(`Sat=${id('Community Time', 6)}`);
      expect(text).toContain(`Sun=${id('Community Time', 0)}`);
      expect(weekdayOnly.userIssues.join('\n')).not.toMatch(/[0-9a-f]{8}-/);
    });

    it('flags the Tuesday Reading & Labs the card left alone (separate series, same slot)', () => {
      expect(r.ok).toBe(false);
      expect(r.issues.join('\n')).toContain(`Tue=${id(READING, 2)}`);
    });

    it('catches a partial delete of a series, naming the days left', () => {
      const del = checkProposal(
        body([
          {
            type: 'DELETE_SCHEDULE_BLOCK',
            id: id('Book', 2),
            expectedTitle: 'Book',
          },
        ]),
        REAL_WEEK,
        { userMessage: 'remove Book' },
      );
      expect(del.ok).toBe(false);
      const text = del.issues.join('\n');
      for (const d of [3, 4, 5]) expect(text).toContain(id('Book', d));
      expect(text.split('FIX:')[1]).not.toContain(id('Book', 2));
      // Deletes are never widened on the user's behalf.
      expect(del.actions).toHaveLength(1);
    });

    it('accepts the delete once every day is in the card', () => {
      const all = checkProposal(
        body(
          [2, 3, 4, 5].map((d) => ({
            type: 'DELETE_SCHEDULE_BLOCK' as const,
            id: id('Book', d),
            expectedTitle: 'Book',
          })),
        ),
        REAL_WEEK,
        { userMessage: 'remove Book' },
      );
      expect(all.ok).toBe(true);
    });

    it('only asks for the days the user named when they named more than one', () => {
      const two = checkProposal(
        body([update('Book', 2, { title: 'Study' })]),
        REAL_WEEK,
        { userMessage: 'Rename Book to Study on Tuesday and Wednesday' },
      );
      expect(two.ok).toBe(false);
      const text = two.issues.join('\n');
      expect(text).toContain(id('Book', 3));
      const fix = text.split('FIX:')[1];
      expect(fix).toContain(id('Book', 3));
      expect(fix).not.toContain(id('Book', 4));
      expect(fix).not.toContain(id('Book', 5));
      expect(fix).not.toContain('updateScope'); // a series update would also change Thu and Fri
    });

    it('accepts one action per day when the card covers all of them', () => {
      const perDay = checkProposal(
        body([2, 3, 4, 5].map((d) => update('Book', d, { title: 'Study' }))),
        REAL_WEEK,
        { userMessage: 'Rename Book to Study' },
      );
      expect(perDay.ok).toBe(true);
      expect(perDay.widened).toBeUndefined();
      expect(perDay.actions).toHaveLength(4);
    });
  });

  describe('2. repurposed an unrelated block', () => {
    it('flags Deep Reading turning into Soft Skills Lab', () => {
      const text = r.issues.join('\n');
      expect(text).toContain('turns "Deep Reading"');
      expect(text).toContain('"Soft Skills Lab"');
      expect(text).toContain('SPLIT_SCHEDULE_BLOCK');
      expect(r.userIssues.join('\n')).toContain(
        '"Deep Reading" (Sat) would turn into "Soft Skills Lab"',
      );
    });

    it('is fine when the user asked to rename that block', () => {
      for (const [title, day, next, msg] of [
        [
          'Book',
          2,
          'Study',
          'Currently it is named "Book" and we will just call it "Study".',
        ],
        [
          'Community Time',
          5,
          'Dev Weekends',
          'replace Community Time with Dev Weekends',
        ],
      ] as const) {
        const ok = checkProposal(
          body([update(title, day, { title: next })]),
          REAL_WEEK,
          { userMessage: msg },
        );
        expect(ok.issues.join('\n')).not.toContain('unrelated title');
      }
    });

    it('is fine when the new title is related to the old one', () => {
      const ok = checkProposal(
        body([update(READING, 4, { title: 'Core Engineering' })]),
        REAL_WEEK,
        { userMessage: 'anything' },
      );
      expect(ok.issues.join('\n')).not.toContain('unrelated title');
    });

    it('does not flag the first piece of a SPLIT, which carries the title the user gave it', () => {
      const split = checkProposal(
        body([
          {
            type: 'SPLIT_SCHEDULE_BLOCK' as any,
            id: id(READING, 2),
            expectedTitle: READING,
            payload: {
              allOccurrences: true,
              pieces: [
                { title: 'Soft Skills Lab', minutes: 30 },
                { title: 'Technical Lab', minutes: 30 },
                { title: 'Core Engineering', minutes: 60 },
              ],
            },
          },
        ]),
        REAL_WEEK,
        { userMessage: 'add two labs to Reading and Labs' },
      );
      expect(split.issues.join('\n')).not.toContain('unrelated title');
      expect(split.ok).toBe(true);
    });
  });

  describe('3. wrong goal links', () => {
    const creates = r.actions.filter((a) => a.type === 'CREATE_SCHEDULE_BLOCK');
    const goalOf = (title: string) =>
      (creates.find((a) => (a.payload as any).title === title)!.payload as any)
        .goalId;

    it('drops the goal copied onto an unrelated create', () => {
      expect(goalOf('Founder Interviews Prep per project')).toBeUndefined();
      expect(
        goalOf('Technical Lab: System Design & Database Challenges'),
      ).toBeUndefined();
    });

    it('keeps it where the goal title is related to the block', () => {
      expect(goalOf('Deep Engineering Reading')).toBe(CORE_GOAL.id);
    });

    it('says which blocks were left unlinked', () => {
      expect(r.notes!.join('\n')).toContain(
        '"Founder Interviews Prep per project"',
      );
    });

    it('keeps a goal the user names', () => {
      const kept = checkProposal(
        body([
          {
            type: 'CREATE_SCHEDULE_BLOCK',
            payload: {
              title: 'Founder Interviews Prep per project',
              startTime: '12:00',
              endTime: '13:00',
              goalId: CORE_GOAL.id,
              dayOfWeek: 6,
            },
          },
        ]),
        REAL_WEEK,
        {
          userMessage:
            'add Founder Interviews Prep at noon, under Core Engineering Study',
          goals: [CORE_GOAL],
        },
      );
      expect((kept.actions[0].payload as any).goalId).toBe(CORE_GOAL.id);
    });

    it('leaves a $ref to a goal created in the same card, and unknown ids, to the apply path', () => {
      const out = checkProposal(
        body([
          {
            type: 'CREATE_SCHEDULE_BLOCK',
            payload: {
              title: 'Gym',
              startTime: '12:00',
              endTime: '13:00',
              goalId: '$ref:0',
              dayOfWeek: 6,
            },
          },
        ]),
        REAL_WEEK,
        { userMessage: 'add Gym', goals: [CORE_GOAL] },
      );
      expect((out.actions[0].payload as any).goalId).toBe('$ref:0');
    });

    it('lets SPLIT pieces inherit the original block goal', () => {
      const withGoal = REAL_WEEK.map((b) =>
        b.title === READING ? { ...b, goalId: CORE_GOAL.id } : b,
      );
      const split = checkProposal(
        body([
          {
            type: 'SPLIT_SCHEDULE_BLOCK' as any,
            id: id(READING, 2),
            expectedTitle: READING,
            payload: {
              allOccurrences: true,
              pieces: [
                { title: 'Core Engineering', minutes: 60 },
                { title: 'Soft Skills Lab', minutes: 30 },
                { title: 'Unrelated Drill', minutes: 30 },
              ],
            },
          },
        ]),
        withGoal,
        { userMessage: 'add labs to Reading and Labs', goals: [CORE_GOAL] },
      );
      const created = split.actions.filter(
        (a) => a.type === 'CREATE_SCHEDULE_BLOCK',
      );
      expect(created).toHaveLength(2);
      for (const c of created) {
        expect((c.payload as any).goalId).toBe(CORE_GOAL.id);
      }
    });
  });

  describe('7. nothing compared the ask with the card', () => {
    it('the card as shipped is no longer accepted as is', () => {
      expect(r.ok).toBe(false);
      expect(r.issues.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------

async function* source(parts: string[]): AsyncGenerator<LlmStreamChunk> {
  for (const p of parts) yield { delta: p, done: false };
  yield {
    delta: '',
    done: true,
    usage: { promptTokens: 1, completionTokens: 1 },
  };
}

async function collect(gen: AsyncIterable<LlmStreamChunk>): Promise<string> {
  let text = '';
  for await (const c of gen) text += c.delta;
  return text;
}

describe('4. stale plan after a repair', () => {
  const original =
    ORIGINAL_LEAD_IN +
    '```coach-proposal\n{"summary":"draft","actions":[]}\n```' +
    ORIGINAL_TRAILING;
  const repairedText =
    '```coach-proposal\n{"summary":"fixed","actions":[]}\n```\n\nI checked this against your schedule and corrected it before showing it.\n\nThis card renames Book and Community Time. Do you want Study to run 3 hours?';

  it('drops the original plan and its coverage claim, keeping a short first sentence', async () => {
    const out = await collect(
      guardProposalStream(source([original]), async () => ({
        text: repairedText,
        card: true,
        repaired: true,
      })),
    );
    expect(out).toContain(
      "Let's break this down into manageable parts, focusing on the changes you've outlined.",
    );
    expect(out).toContain('"summary":"fixed"');
    expect(out).toContain('Do you want Study to run 3 hours?');
    expect(out).not.toMatch(/1\. \*\*Rename/);
    expect(out).not.toContain('Keep "Work" as is');
    expect(out).not.toContain('handles all your requests');
    expect(out).not.toContain('Here’s how it looks');
    expect(out).not.toContain('Please review it');
    expect(out).not.toContain('expanded weekend schedule');
  });

  it('keeps the plan when the card was NOT repaired (it matches the card)', async () => {
    const out = await collect(
      guardProposalStream(source([original]), async () => ({
        text: '```coach-proposal\n{"summary":"ok","actions":[]}\n```',
        card: true,
      })),
    );
    expect(out).toContain('Keep "Work" as is');
    expect(out).toContain('handles all your requests');
  });

  it('never keeps a first sentence that claims coverage or points at the card', async () => {
    for (const first of [
      'This proposal handles all your requests.',
      'Here is the proposal below.',
      'I will cover every change you listed.',
    ]) {
      const out = await collect(
        guardProposalStream(
          source([
            `${first} Then more.\n\n1. one\n2. two\n\n`,
            '```coach-proposal\n{"actions":[]}\n```',
          ]),
          async () => ({ text: 'CARD', card: true, repaired: true }),
        ),
      );
      expect(out).toBe('CARD');
    }
  });

  it('drops prose after the card but still guards a second card', async () => {
    const calls: string[] = [];
    const out = await collect(
      guardProposalStream(
        source([
          'Intro sentence.\n\n```coach-proposal\n{"a":1}\n```\n\nClaims everything.\n\n```coach-proposal\n{"a":2}\n```\n',
        ]),
        async (b) => {
          calls.push(b);
          return b.includes('"a":1')
            ? { text: 'CARD1', card: true, repaired: true }
            : { text: 'CARD2', card: true };
        },
      ),
    );
    expect(calls).toHaveLength(2);
    expect(out).toContain('CARD1');
    expect(out).toContain('CARD2');
    expect(out).not.toContain('Claims everything');
  });

  it('finalizeProposal marks a repaired card and strips a coverage claim from the repair closing', async () => {
    const service = new CoachAiService({} as any, {} as any, {} as any);
    const good = JSON.stringify({
      summary: 'x',
      actions: [update('Book', 2, { title: 'Study' })],
    });
    const replies = [
      '```coach-proposal\n' +
        good +
        '\n```\nThis card handles all your requests. Do you want 3 hours of Study?',
    ];
    const provider = {
      streamCompletion: async function* () {
        yield { delta: replies.shift() ?? '', done: false };
        yield {
          delta: '',
          done: true,
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      },
    };
    const result = await (service as any).finalizeProposal({
      body: body([update('Book', 99 as any, { title: 'Study' })]),
      prose: '',
      blocks: REAL_WEEK,
      provider,
      model: 'm',
      messages: [],
      userId: 'u',
    });
    expect(result.card).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.text).not.toContain('handles all your requests');
    expect(result.text).toContain('Do you want 3 hours of Study?');
  });
});

// ---------------------------------------------------------------------------

describe('5. the false "I haven\'t changed anything yet."', () => {
  const service = new CoachAiService({} as any, {} as any, {} as any);
  const history = (applied: boolean) => {
    const turns = [
      { id: 'u1', role: CoachRole.USER, content: USER_MESSAGE },
      { id: 'a1', role: CoachRole.ASSISTANT, content: 'Here is the card.' },
      { id: 'u2', role: CoachRole.USER, content: FOLLOW_UP },
    ];
    return buildCoachChatMessages(
      contextFor(REAL_WEEK),
      turns,
      new Map(
        applied
          ? [
              [
                'a1',
                renderApplyNote({ outcome: 'applied', results: APPLY_RESULTS }),
              ],
            ]
          : [],
      ),
    );
  };
  const bad = body([update('Book', 99 as any, { title: 'Study' })]);
  const finalize = (messages: any[], replies: string[]) =>
    (service as any).finalizeProposal({
      body: bad,
      prose: '',
      blocks: REAL_WEEK,
      provider: {
        streamCompletion: async function* () {
          yield { delta: replies.shift() ?? '', done: false };
          yield { delta: '', done: true };
        },
      },
      model: 'm',
      messages,
      userId: 'u',
    }) as Promise<{ text: string; card?: boolean }>;

  it('says "No new change from this reply." when the model asks instead (applied card earlier)', async () => {
    const r = await finalize(history(true), ['Which block do you mean?']);
    expect(r.card).toBe(false);
    expect(r.text).toContain(NO_NEW_CHANGE);
    expect(r.text).not.toContain(NOTHING_CHANGED);
    expect(r.text).toContain('Which block do you mean?');
  });

  it('says it too when the card is withheld after two failed repairs', async () => {
    const r = await finalize(history(true), [
      '```coach-proposal\n' + bad + '\n```',
      '```coach-proposal\n' + bad + '\n```',
    ]);
    expect(r.card).toBe(false);
    expect(r.text).toContain(NO_NEW_CHANGE);
    expect(r.text).not.toContain(NOTHING_CHANGED);
  });

  it('still says nothing was changed when nothing was applied', async () => {
    const r = await finalize(history(false), ['Which block do you mean?']);
    expect(r.text).toContain(NOTHING_CHANGED);
    expect(r.text).not.toContain(NO_NEW_CHANGE);
  });

  it('a refused or failed apply is not a change either', async () => {
    const messages = buildCoachChatMessages(
      contextFor(REAL_WEEK),
      [
        { id: 'u1', role: CoachRole.USER, content: 'x' },
        { id: 'a1', role: CoachRole.ASSISTANT, content: 'card' },
        { id: 'u2', role: CoachRole.USER, content: 'y' },
      ],
      new Map([
        [
          'a1',
          renderApplyNote({
            outcome: 'refused',
            results: [{ ok: false, index: 0, type: 'UPDATE_SCHEDULE_BLOCK' }],
          }),
        ],
      ]),
    );
    const r = await finalize(messages, ['Which block?']);
    expect(r.text).toContain(NOTHING_CHANGED);
  });
});

// ---------------------------------------------------------------------------

describe('6. a quoted title that matches no block', () => {
  const lines = renderUnmatchedQuotedTitles(USER_MESSAGE, REAL_WEEK);

  it('names "Talking About Weekdays" and nothing the user was only naming', () => {
    expect(lines).toContain('"Talking About Weekdays"');
    for (const fine of [
      'Reading and Labs', // matches "Reading & Labs (Core Engineering)"
      'Core Engineering', // new name
      'Book',
      'Study', // new name
      'Work',
      'Community Time',
      'Dev Weekends', // new name
    ]) {
      expect(lines).not.toContain(`"${fine}"`);
    }
    expect(lines.split('\n')).toHaveLength(1);
  });

  it('lands in the schedule context of the turn, with the instruction to ask', () => {
    const messages = buildCoachChatMessages(contextFor(REAL_WEEK), [
      { id: 'u1', role: CoachRole.USER, content: USER_MESSAGE },
    ]);
    const context = messages[1].content;
    expect(context).toContain('match no block on the schedule');
    expect(context).toContain('ASK which block they mean');
    expect(context).toContain('"Talking About Weekdays"');
  });

  it('adds nothing when every quoted title matches, so the context is unchanged', () => {
    const messages = buildCoachChatMessages(contextFor(REAL_WEEK), [
      { id: 'u1', role: CoachRole.USER, content: 'rename "Book" to "Study"' },
    ]);
    expect(messages[1].content).not.toContain('match no block on the schedule');
  });

  it('reads only the last user message', () => {
    const messages = buildCoachChatMessages(contextFor(REAL_WEEK), [
      { id: 'u1', role: CoachRole.USER, content: USER_MESSAGE },
      { id: 'a1', role: CoachRole.ASSISTANT, content: 'ok' },
      { id: 'u2', role: CoachRole.USER, content: FOLLOW_UP },
    ]);
    expect(messages[1].content).not.toContain('Talking About Weekdays"');
  });

  it('offers the closest titles when there are any, and skips new blocks being created', () => {
    const near = renderUnmatchedQuotedTitles(
      'move "Leaf Compute" to 6 pm and add a block "Gym" at noon',
      REAL_WEEK,
    );
    expect(near).toContain('closest: "LeafCompute"');
    expect(near).not.toContain('Gym');
  });
});

// ---------------------------------------------------------------------------

describe('D. reviewer pass for big proposals', () => {
  const service = new CoachAiService({} as any, {} as any, {} as any);
  const card = JSON.stringify({
    summary: 's',
    actions: [update('Book', 2, { title: 'Study' })],
  });
  const BULLETS = '- one\n- two\n- three\n- four\nrename Book to Study';

  function run(opts: {
    userMessage: string;
    reviewer: string | Error;
    review?: boolean;
    body?: string;
    models?: string[];
  }) {
    const calls: Array<{ model: string; system: string; user: string }> = [];
    const provider = {
      streamCompletion: async function* (messages: any[], model: string) {
        calls.push({
          model,
          system: messages[0].content,
          user: messages[messages.length - 1].content,
        });
        if (opts.reviewer instanceof Error) throw opts.reviewer;
        yield { delta: opts.reviewer, done: false };
        yield {
          delta: '',
          done: true,
          usage: { promptTokens: 7, completionTokens: 3 },
        };
      },
    };
    return (service as any)
      .finalizeProposal({
        body: opts.body ?? card,
        prose: '',
        blocks: REAL_WEEK,
        provider,
        model: 'gpt-4o-mini',
        repairModel: 'gpt-4.1',
        review: opts.review ?? true,
        messages: [{ role: 'user', content: opts.userMessage }],
        userId: 'u',
      })
      .then((r: { text: string; usage?: any }) => ({ r, calls }));
  }

  it('counts list items however they are written', () => {
    expect(countAsks(BULLETS)).toBe(4);
    expect(countAsks('1. a\n2) b\n3. c')).toBe(3);
    expect(countAsks(USER_MESSAGE)).toBeGreaterThanOrEqual(4);
    expect(
      countAsks(
        'x - Keep the block - 30-minute lab first - We will spend 3 hours - Work will continue',
      ),
    ).toBe(4);
    expect(shouldReview('one ask', [])).toBe(false);
    expect(shouldReview(BULLETS, [])).toBe(true);
    expect(
      shouldReview(
        'one ask',
        Array.from(
          { length: 6 },
          () => ({ type: 'UPDATE_SCHEDULE_BLOCK' }) as any,
        ),
      ),
    ).toBe(true);
  });

  it('appends "Not covered by this card:" after the card, never blocking it, and charges the tokens', async () => {
    const { r, calls } = await run({
      userMessage: BULLETS,
      reviewer: JSON.stringify({
        notCovered: [
          'Tuesday and Thursday labs inside Reading & Labs',
          `Deep Reading ${id('Deep Reading', 6)} moves to 9 AM`,
        ],
        differently: ['Dev Weekends is only on Friday'],
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('gpt-4.1'); // the repair model, same key
    expect(calls[0].user).toContain(BULLETS);
    expect(calls[0].user).toContain('Tue: ');
    expect(calls[0].user).toContain('Study'); // the resulting schedule
    expect(r.text.startsWith('```coach-proposal')).toBe(true);
    expect(r.text).toContain('Not covered by this card:');
    expect(r.text).toContain(
      '- Tuesday and Thursday labs inside Reading & Labs',
    );
    expect(r.text).toContain(
      '- Done differently: Dev Weekends is only on Friday',
    );
    expect(r.text.split('```')[2]).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(r.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
  });

  it('adds nothing when the reviewer finds nothing', async () => {
    const { r } = await run({
      userMessage: BULLETS,
      reviewer: '{"notCovered":[],"differently":[]}',
    });
    expect(r.text).not.toContain('Not covered');
  });

  it('makes no call for a small request, or on the shared key', async () => {
    const small = await run({ userMessage: 'rename Book', reviewer: '{}' });
    expect(small.calls).toHaveLength(0);
    const shared = await run({
      userMessage: BULLETS,
      reviewer: '{}',
      review: false,
    });
    expect(shared.calls).toHaveLength(0);
  });

  it('shows the card on any failure: a throw, or junk back', async () => {
    const threw = await run({
      userMessage: BULLETS,
      reviewer: new Error('403'),
    });
    expect(threw.r.text.startsWith('```coach-proposal')).toBe(true);
    expect(threw.r.text).not.toContain('Not covered');
    // It tried the escalated model, then the user's own.
    expect(threw.calls.map((c: { model: string }) => c.model)).toEqual([
      'gpt-4.1',
      'gpt-4o-mini',
    ]);
    const junk = await run({ userMessage: BULLETS, reviewer: 'sorry, no' });
    expect(junk.r.text).not.toContain('Not covered');
  });

  it('caps the list: at most 6 per kind, 200 characters each, no ids', () => {
    const long = 'x'.repeat(500);
    const parsed = parseReview(
      JSON.stringify({
        notCovered: Array.from({ length: 10 }, (_, i) => `item ${i}`),
        differently: [long],
      }),
    )!;
    expect(parsed.notCovered).toHaveLength(6);
    expect(parsed.differently[0].length).toBeLessThanOrEqual(203);
    expect(renderNotCovered({ notCovered: [], differently: [] })).toBe('');
  });

  it('simulates series scope, deletes, creates and moves for the reviewer', () => {
    const after = simulateCard(REAL_WEEK, [
      {
        type: 'UPDATE_SCHEDULE_BLOCK',
        id: id('Book', 2),
        payload: { title: 'Study', updateScope: 'series' },
      },
      { type: 'DELETE_SCHEDULE_BLOCK', id: id('Work', 1) },
      {
        type: 'CREATE_SCHEDULE_BLOCK',
        payload: {
          title: 'Gym',
          startTime: '12:00',
          endTime: '13:00',
          daysOfWeek: [6, 0],
        },
      },
    ]);
    expect(after.filter((b) => b.title === 'Study')).toHaveLength(4);
    expect(after.filter((b) => b.title === 'Work')).toHaveLength(4);
    expect(after.filter((b) => b.title === 'Gym')).toHaveLength(2);
  });
});

describe('review findings on the stream and the reviewer call', () => {
  it('holds a wrapped plan item together with its first line', async () => {
    const plan =
      'Here is the plan.\n\n1. Move Book to 9\n   on Tuesday.\n2. Move Work to 10\n   on Wednesday.\n\nHere is the card:\n';
    const seen: string[] = [];
    const source = (async function* () {
      yield { delta: plan, done: false } as LlmStreamChunk;
      yield {
        delta: '```coach-proposal\n{}\n```',
        done: false,
      } as LlmStreamChunk;
      yield { delta: '', done: true } as LlmStreamChunk;
    })();
    const out: string[] = [];
    for await (const c of guardProposalStream(source, async () => {
      seen.push(out.join(''));
      return { text: '```coach-proposal\n{}\n```', card: true, repaired: true };
    })) {
      out.push(c.delta);
    }
    // Nothing of the wrapped plan was streamed before finalize ran.
    expect(seen[0]).not.toContain('Move Book');
    expect(seen[0]).not.toContain('on Tuesday');
    expect(out.join('')).not.toContain('Move Work');
  });

  it('strips completion-wording coverage claims', () => {
    expect(
      stripCoverageClaims(
        'I have made all the changes you requested. Do you want Study at 3 hours?',
      ),
    ).toBe('Do you want Study at 3 hours?');
    expect(
      stripCoverageClaims("I've completed every change. Which block is it?"),
    ).toBe('Which block is it?');
  });

  it('shows the card without the list when the review call stalls', async () => {
    const service = new CoachAiService({} as any, {} as any, {} as any);
    const provider = {
      streamCompletion: async function* () {
        await new Promise(() => undefined); // never resolves
        yield { delta: '', done: true };
      },
    };
    const started = Date.now();
    const res = await (service as any).reviewCard({
      provider,
      models: ['gpt-4.1', 'gpt-4o-mini'],
      userMessage: 'one\ntwo',
      blocks: REAL_WEEK,
      actions: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      userId: 'u',
      timeoutMs: 40,
    });
    expect(res).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
