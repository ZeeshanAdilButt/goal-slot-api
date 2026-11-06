import { readFileSync } from 'fs';
import { join } from 'path';
import { checkProposal, repairInstruction } from '../proposal-guard';
import { guardProposalStream } from '../proposal-stream';
import { CoachAiService, proseOnly } from '../coach-ai.service';
import { REAL_WEEK, SCENARIOS } from '../__evals__/scenarios';
import { idsOf, parseReply, universalChecks } from '../__evals__/harness';
import { LlmStreamChunk } from '../../../shared/services/llm/llm.interface';

const recorded4oMini = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '__evals__',
      'recordings',
      'gpt-4o-mini',
      'weekend-restructure.json',
    ),
    'utf8',
  ),
).text as string;

function proposalBody(text: string): string {
  return /```coach-proposal\s*([\s\S]*?)```/.exec(text)![1];
}

const READING = 'Reading & Labs (Core Engineering)';

/** What a correct answer to the production request looks like, written the lean way. */
const GOOD = JSON.stringify({
  summary:
    'Core Engineering with two labs, Study, Dev Weekends, weekend reshuffle',
  actions: [
    {
      type: 'SPLIT_SCHEDULE_BLOCK',
      id: idsOf(REAL_WEEK, READING, [2])[0],
      expectedTitle: READING,
      payload: {
        allOccurrences: true,
        pieces: [
          { title: 'Core Engineering', minutes: 60 },
          { title: 'Soft Skills Lab', minutes: 30 },
          {
            title: 'Tech Lab: System Design, DB, SD Challenges, AI Agents',
            minutes: 30,
          },
        ],
      },
    },
    ...idsOf(REAL_WEEK, 'Book').map((id) => ({
      type: 'UPDATE_SCHEDULE_BLOCK',
      id,
      payload: { title: 'Study' },
    })),
    ...idsOf(REAL_WEEK, 'Community Time').map((id) => ({
      type: 'UPDATE_SCHEDULE_BLOCK',
      id,
      expectedTitle: 'Community Time',
      payload: { title: 'Dev Weekends' },
    })),
    ...idsOf(REAL_WEEK, 'Deep Reading').map((id) => ({
      type: 'UPDATE_SCHEDULE_BLOCK',
      id,
      expectedTitle: 'Deep Reading',
      payload: { startTime: '09:00', endTime: '12:00' },
    })),
    // Listed BEFORE nothing in particular: the guard and the executor judge the
    // finished schedule, so these may come before the Deep Reading shrink.
    {
      type: 'UPDATE_SCHEDULE_BLOCK',
      id: idsOf(REAL_WEEK, 'Career Strategy and Applications')[0],
      expectedTitle: 'Career Strategy and Applications',
      payload: { startTime: '07:00', endTime: '08:00' },
    },
    {
      type: 'UPDATE_SCHEDULE_BLOCK',
      id: idsOf(REAL_WEEK, 'Branding and Great Content')[0],
      expectedTitle: 'Branding and Great Content',
      payload: { startTime: '07:00', endTime: '08:00' },
    },
    {
      type: 'CREATE_SCHEDULE_BLOCK',
      payload: {
        title: 'Founder Interviews Prep',
        startTime: '08:00',
        endTime: '09:00',
        daysOfWeek: [0, 6],
        category: 'WORK',
      },
    },
  ],
});

describe('checkProposal', () => {
  it('catches every problem in the production gpt-4o-mini proposal', () => {
    const r = checkProposal(proposalBody(recorded4oMini), REAL_WEEK);
    const all = r.issues.join('\n');

    expect(r.ok).toBe(false);
    // 1. the hallucinated Reading & Labs id, with the real ids offered back
    expect(all).toMatch(
      /a894b37d-a2f3-4d64-b0b5-8fe9e0a36f62, which is not one of the user's blocks/,
    );
    expect(all).toContain(`Tue=${idsOf(REAL_WEEK, READING, [2])[0]}`);
    // 2. labs on top of Book (already renamed Study by the same batch)
    expect(all).toMatch(/Tuesday 9:00 AM to 9:30 AM would overlap "Study"/);
    // 4. weekend moves onto a block that has not moved, and onto each other
    expect(all).toMatch(
      /Saturday 7:00 AM to 9:00 AM would overlap "Deep Reading"/,
    );
    // 7. the invented 5 AM block on top of family time
    expect(all).toMatch(
      /Saturday 5:00 AM to 6:00 AM would overlap "Family Time"/,
    );
  });

  it('accepts the lean correct answer, expanding the split on both Tue and Thu', () => {
    const r = checkProposal(GOOD, REAL_WEEK);

    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    const splitUpdates = r.actions.filter(
      (a) => a.type === 'UPDATE_SCHEDULE_BLOCK' && a.expectedTitle === READING,
    );
    expect(splitUpdates.map((a) => a.payload)).toEqual([
      { title: 'Core Engineering', startTime: '07:00', endTime: '08:00' },
      { title: 'Core Engineering', startTime: '07:00', endTime: '08:00' },
    ]);
    const labs = r.actions.filter(
      (a) =>
        a.type === 'CREATE_SCHEDULE_BLOCK' &&
        /Lab/.test(String(a.payload?.title)),
    );
    expect(labs.map((a) => a.payload)).toEqual([
      expect.objectContaining({
        title: 'Soft Skills Lab',
        startTime: '08:00',
        endTime: '08:30',
        daysOfWeek: [2, 4],
      }),
      expect.objectContaining({
        startTime: '08:30',
        endTime: '09:00',
        daysOfWeek: [2, 4],
      }),
    ]);
    // A missing expectedTitle on a real id is filled in, not reported.
    expect(
      r.actions.find((a) => a.id === idsOf(REAL_WEEK, 'Book')[0])
        ?.expectedTitle,
    ).toBe('Book');
  });

  it('refuses a split whose pieces do not fit the block, and says by how much', () => {
    const r = checkProposal(
      JSON.stringify({
        actions: [
          {
            type: 'SPLIT_SCHEDULE_BLOCK',
            id: idsOf(REAL_WEEK, 'Book', [2])[0],
            payload: {
              allOccurrences: false,
              pieces: [{ title: 'Study', minutes: 180 }],
            },
          },
        ],
      }),
      REAL_WEEK,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(
      /add up to 180 minutes but the block is 120 minutes/,
    );
  });

  it('rejects something that is not JSON', () => {
    expect(checkProposal('{ nope', REAL_WEEK).ok).toBe(false);
  });

  it('builds a repair instruction that lists the problems', () => {
    expect(repairInstruction(['a', 'b'])).toContain('- a\n- b');
  });
});

async function* chunks(parts: string[]): AsyncGenerator<LlmStreamChunk> {
  for (const p of parts) yield { delta: p, done: false };
  yield {
    delta: '',
    done: true,
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

async function collect(gen: AsyncIterable<LlmStreamChunk>) {
  let text = '';
  let usage;
  for await (const c of gen) {
    text += c.delta;
    if (c.done) usage = c.usage;
  }
  return { text, usage };
}

describe('guardProposalStream', () => {
  it('streams prose through and swaps the held-back block for what finalize returns', async () => {
    const seen: string[] = [];
    const out = await collect(
      guardProposalStream(
        chunks([
          'Here ',
          'it is.\n\n``',
          '`coach-prop',
          'osal\n{"actions":[]}\n`',
          '``\n\nDone.',
        ]),
        async (body, prose) => {
          seen.push(body, prose);
          return {
            text: '[CARD]',
            usage: { promptTokens: 1, completionTokens: 2 },
          };
        },
      ),
    );
    expect(seen).toEqual(['{"actions":[]}', 'Here it is.\n\n']);
    expect(out.text).toBe('Here it is.\n\n[CARD]\n\nDone.');
    expect(out.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  it('never leaks a truncated block when the model stops mid-proposal', async () => {
    const out = await collect(
      guardProposalStream(
        chunks(['Plan:\n```coach-proposal\n{"actions": [']),
        async () => ({
          text: '[WITHHELD]',
        }),
      ),
    );
    expect(out.text).toBe('Plan:\n[WITHHELD]');
  });

  it('passes text with no proposal through unchanged', async () => {
    const out = await collect(
      guardProposalStream(chunks(['a `b` ``c`` ', 'd']), async () => ({
        text: 'x',
      })),
    );
    expect(out.text).toBe('a `b` ``c`` d');
  });
});

describe('CoachAiService.finalizeProposal', () => {
  const service = new CoachAiService({} as any, {} as any, {} as any);
  const finalize = (body: string, replies: string[]) => {
    const provider = {
      streamCompletion: async function* () {
        const next = replies.shift() ?? '';
        yield { delta: next, done: false };
        yield {
          delta: '',
          done: true,
          usage: { promptTokens: 100, completionTokens: 20 },
        };
      },
    };
    return (service as any).finalizeProposal({
      body,
      prose: '',
      blocks: REAL_WEEK,
      provider,
      model: 'm',
      messages: [],
      userId: 'u',
    }) as Promise<{ text: string; usage?: { promptTokens: number } }>;
  };

  it('shows a valid proposal as is, with no extra model call', async () => {
    const r = await finalize(GOOD, []);
    expect(parseReply(r.text).proposals).toHaveLength(1);
    expect(r.usage).toBeUndefined();
  });

  it('repairs the production 4o-mini proposal when the model fixes it on the second try', async () => {
    const r = await finalize(proposalBody(recorded4oMini), [
      '```coach-proposal\n' +
        GOOD +
        '\n```\nHow do you want to fit 3 hours of Study before Work at 11?',
    ]);
    const parsed = parseReply(r.text);
    expect(parsed.proposals).toHaveLength(1);
    expect(
      checkProposal(JSON.stringify(parsed.proposals[0]), REAL_WEEK).ok,
    ).toBe(true);
    expect(r.text).toContain('3 hours of Study');
    expect(r.usage?.promptTokens).toBe(100);
  });

  it('withholds the card and asks in plain words when two repairs still fail', async () => {
    const bad = proposalBody(recorded4oMini);
    const r = await finalize(bad, [
      '```coach-proposal\n' + bad + '\n```',
      '```coach-proposal\n' + bad + '\n```',
    ]);
    expect(parseReply(r.text).proposals).toHaveLength(0);
    expect(r.text).toMatch(/couldn't turn that into a change/);
    expect(r.text).toMatch(/How would you like to handle that\?/);
  });

  it("passes on the model's question when it chooses to ask instead of proposing", async () => {
    const r = await finalize(proposalBody(recorded4oMini), [
      'Should Study start at 8:00 AM, or end at 12:00 PM?',
    ]);
    expect(parseReply(r.text).proposals).toHaveLength(0);
    expect(r.text.trim()).toBe(
      'Should Study start at 8:00 AM, or end at 12:00 PM?',
    );
  });
});

const split = (
  id: string | undefined,
  expectedTitle: string | undefined,
  payload: unknown,
) =>
  JSON.stringify({
    actions: [{ type: 'SPLIT_SCHEDULE_BLOCK', id, expectedTitle, payload }],
  });
const TWO_LABS = {
  allOccurrences: true,
  pieces: [
    { title: 'Soft Skills Lab', minutes: 30 },
    { title: 'Tech Lab', minutes: 30 },
  ],
};

describe('SPLIT_SCHEDULE_BLOCK anchor (CodeRabbit #125)', () => {
  it('refuses a real id whose block does not have the expected title, instead of splitting it', () => {
    const workId = idsOf(REAL_WEEK, 'Work', [2])[0];
    const r = checkProposal(split(workId, READING, TWO_LABS), REAL_WEEK);

    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(
      /is "Work", not "Reading & Labs \(Core Engineering\)"/,
    );
    expect(
      r.actions.some((a) => idsOf(REAL_WEEK, 'Work').includes(a.id ?? '')),
    ).toBe(false);
  });

  it('accepts an unknown id when the title names the block exactly, and splits every occurrence', () => {
    const r = checkProposal(
      split('not-a-real-id', READING, TWO_LABS),
      REAL_WEEK,
    );

    expect(r.issues).toEqual([]);
    expect(
      r.actions
        .filter((a) => a.type === 'UPDATE_SCHEDULE_BLOCK')
        .map((a) => a.id)
        .sort(),
    ).toEqual([...idsOf(REAL_WEEK, READING)].sort());
  });

  it('refuses a one-occurrence split by title when the title is on several days', () => {
    const r = checkProposal(
      split('not-a-real-id', READING, { ...TWO_LABS, allOccurrences: false }),
      REAL_WEEK,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/needs that occurrence's id/);
  });
});

describe('SPLIT_SCHEDULE_BLOCK pieces (CodeRabbit #125)', () => {
  const tue = () => idsOf(REAL_WEEK, READING, [2])[0];

  it('coerces whole-number strings', () => {
    const r = checkProposal(
      split(tue(), READING, {
        pieces: [
          { title: 'Soft Skills Lab', minutes: '30' },
          { title: 'Tech Lab', minutes: 30 },
        ],
      }),
      REAL_WEEK,
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    [{ title: 'Tech Lab', minutes: 22.5 }],
    [{ title: 'Tech Lab', minutes: 'half an hour' }],
    [{ title: 42, minutes: 30 }],
    [{ minutes: 30 }],
  ])('reports a bad piece instead of silently dropping it: %j', (bad) => {
    const r = checkProposal(
      split(tue(), READING, {
        pieces: [{ title: 'Soft Skills Lab', minutes: 30 }, bad],
      }),
      REAL_WEEK,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/invalid pieces: piece 2/);
    // Nothing from this split reaches the card: no half-built proposal.
    expect(r.actions.some((a) => a.type === 'CREATE_SCHEDULE_BLOCK')).toBe(
      false,
    );
  });
});

describe('what reaches the user (CodeRabbit #125)', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
  const TYPES = /(UPDATE|DELETE|CREATE|SPLIT)_SCHEDULE_BLOCK/;

  it('user-facing reasons never name an id or an action type', () => {
    const r = checkProposal(proposalBody(recorded4oMini), REAL_WEEK);
    expect(r.userIssues.length).toBe(r.issues.length);
    for (const x of r.userIssues) {
      expect(x).not.toMatch(UUID);
      expect(x).not.toMatch(TYPES);
    }
    expect(r.userIssues[0]).toBe(
      'A change to "Reading & Labs" pointed at a block that is not in your schedule.',
    );
  });

  it('proseOnly strips every fence, an unclosed one included, and never cuts inside one', () => {
    expect(
      proseOnly('Fine.\n```coach-proposal\n{"actions":[]}\n```\nMore.'),
    ).toBe('Fine.\n\nMore.');
    expect(proseOnly('Ask? ```coach-proposal\n{"actions": [')).toBe('Ask?');
    const long = proseOnly('word '.repeat(300));
    expect(long.length).toBeLessThanOrEqual(601);
    expect(long).not.toContain('`');
  });
});

describe('CoachAiService.finalizeProposal repair tail (CodeRabbit #125)', () => {
  const service = new CoachAiService({} as any, {} as any, {} as any);
  it('drops a second proposal fence the repair reply puts after its block', async () => {
    const replies = [
      '```coach-proposal\n' +
        GOOD +
        '\n```\nAlso:\n```coach-proposal\n{"actions":[{"type":"DELETE_SCHEDULE_BLOCK","id":"x"}]}\n```\nWant 3 hours of Study?',
    ];
    const r = await (service as any).finalizeProposal({
      body: proposalBody(recorded4oMini),
      prose: '',
      blocks: REAL_WEEK,
      provider: {
        streamCompletion: async function* () {
          yield { delta: replies.shift() ?? '', done: false };
          yield { delta: '', done: true };
        },
      },
      model: 'm',
      messages: [],
      userId: 'u',
    });
    expect((r.text.match(/```coach-proposal/g) ?? []).length).toBe(1);
    expect(r.text).toContain('Want 3 hours of Study?');
    expect(r.text).not.toContain('"id":"x"');
  });
});

describe('eval harness judges SPLIT replies on what they produce (CodeRabbit #125)', () => {
  it('a correct split reply passes replace-one-with-two', () => {
    const s = SCENARIOS.find((x) => x.id === 'replace-one-with-two')!;
    const text =
      'Reading & Labs is on Tue and Thu, so I changed it on both. Blocks only hold a title, so the lab topics go in the title. This frees 8:00 to 9:00 AM on both days; want to leave it free?\n\n```coach-proposal\n' +
      split(idsOf(REAL_WEEK, READING, [2])[0], READING, {
        allOccurrences: true,
        pieces: [
          { title: 'Soft Skills', minutes: 30 },
          {
            title: 'Tech Labs: System Design, DB, SD Challenges, AI Agents',
            minutes: 30,
          },
        ],
      }) +
      '\n```';
    const r = parseReply(text);
    expect([...universalChecks(s.blocks, r), ...s.check(r, s.blocks)]).toEqual(
      [],
    );
  });
});
