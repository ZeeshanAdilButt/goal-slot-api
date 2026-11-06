import { readFileSync } from 'fs';
import { join } from 'path';
import { CoachAiService, stripCardReferences } from '../coach-ai.service';
import { checkProposal, repairInstruction } from '../proposal-guard';
import { guardProposalStream } from '../proposal-stream';
import { repairModelFor } from '../repair-model';
import { REAL_WEEK } from '../__evals__/scenarios';
import { idsOf } from '../__evals__/harness';
import { LlmStreamChunk } from '../../../shared/services/llm/llm.interface';

/**
 * The second production reply to the owner's weekend request (gpt-4o-mini,
 * 2026-11-06 05:34 UTC): the guard held, so there was no dead card, but the
 * text was incoherent. A 12-point plan ended in "Here's how the actions will
 * look in the proposal:", then the withdrawn repair's question, then the
 * original reply's "Please review this proposal ... to apply!" with no card.
 */
const REC = join(__dirname, '..', '__evals__', 'recordings', 'gpt-4o-mini');
const fx = JSON.parse(
  readFileSync(join(REC, 'weekend-restructure-repair.json'), 'utf8'),
);
const draft = /```coach-proposal\s*([\s\S]*?)```/.exec(
  JSON.parse(readFileSync(join(REC, 'weekend-restructure.json'), 'utf8')).text,
)![1];

async function* chunks(parts: string[]): AsyncGenerator<LlmStreamChunk> {
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

function serviceReplying(replies: string[], models: string[] = []) {
  const service = new CoachAiService({} as any, {} as any, {} as any);
  const provider = {
    streamCompletion: async function* (_m: unknown, model: string) {
      models.push(model);
      yield { delta: replies.shift() ?? '', done: false };
      yield {
        delta: '',
        done: true,
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
  const finalize = (body: string, prose: string, repairModel?: string) =>
    (service as any).finalizeProposal({
      body,
      prose,
      blocks: REAL_WEEK,
      provider,
      model: 'gpt-4o-mini',
      messages: [],
      userId: 'u',
      repairModel,
    });
  return { finalize };
}

describe('production replay: withdrawn repair (A)', () => {
  it('leaves no text that refers to a card that is not there', async () => {
    const { finalize } = serviceReplying([fx.repairReply]);
    // The source, chunked the way a provider streams: the plan, the lead-in,
    // the block, then the original after-block sentence.
    const source = chunks([
      fx.prose.slice(0, 200),
      fx.prose.slice(200),
      '```coach-proposal\n',
      draft,
      '\n```\n\n',
      fx.tail,
    ]);
    const out = await collect(
      guardProposalStream(source, (body, prose) => finalize(body, prose)),
    );

    expect(out).not.toContain(
      'Here’s how the actions will look in the proposal:',
    );
    expect(out).not.toContain('Please review this proposal');
    expect(out).not.toContain('```');
    expect(out).toContain('could you confirm the following');
    // The 12-point plan described changes that were never made: gone too,
    // so the reply opens with the plain line.
    expect(out).not.toContain('Rename the "Reading & Labs" block');
    expect(out.trimStart().startsWith("I haven't changed anything yet.")).toBe(
      true,
    );
  });
});

describe('no-card text cleanup (A)', () => {
  it('drops sentences that ask to review or apply a proposal, and keeps the question', () => {
    expect(
      stripCardReferences(
        'Should Study start at 8:00 AM? Please review this proposal and let me know if everything looks correct for you to apply!',
      ),
    ).toBe('Should Study start at 8:00 AM?');
    expect(
      stripCardReferences("Here's the proposal below.\nWhich day works?"),
    ).toBe('Which day works?');
    // A question that merely mentions the word stays.
    expect(
      stripCardReferences('Do you want me to change the proposal to Tuesday?'),
    ).toBe('Do you want me to change the proposal to Tuesday?');
  });

  it('keeps a lead-in line when the card IS shown', async () => {
    const good = JSON.stringify({
      actions: [
        {
          type: 'UPDATE_SCHEDULE_BLOCK',
          id: idsOf(REAL_WEEK, 'Book', [2])[0],
          expectedTitle: 'Book',
          payload: { title: 'Study', updateScope: 'series' },
        },
      ],
    });
    const out = await collect(
      guardProposalStream(
        chunks([
          'Here is the change:\n',
          '```coach-proposal\n',
          good,
          '\n```\nDone.',
        ]),
        async () => ({
          text: '[CARD]',
          card: true,
        }),
      ),
    );
    expect(out).toBe('Here is the change:\n[CARD]\nDone.');
  });

  it('streams a list with no proposal in full, and releases it once prose follows', async () => {
    const parts = [
      'Try these:\n',
      '1. Sleep by 11\n',
      '2. Walk after lunch\n',
      'Pick one for this week.',
    ];
    const seen: string[] = [];
    for await (const c of guardProposalStream(chunks(parts), async () => ({
      text: 'x',
    }))) {
      if (c.delta) seen.push(c.delta);
    }
    expect(seen.join('')).toBe(parts.join(''));
  });

  it('keeps the plan before a card that IS shown', async () => {
    const out = await collect(
      guardProposalStream(
        chunks([
          'Plan:\n1. Rename Book\n\n',
          '```coach-proposal\n{"actions":[]}\n```',
        ]),
        async () => ({
          text: '[CARD]',
          card: true,
        }),
      ),
    );
    expect(out).toBe('Plan:\n1. Rename Book\n\n[CARD]');
  });

  it('streams ordinary prose with no proposal unchanged', async () => {
    const out = await collect(
      guardProposalStream(
        chunks(['Line one.\n', 'Line two, ', 'still going.']),
        async () => ({ text: 'x' }),
      ),
    );
    expect(out).toBe('Line one.\nLine two, still going.');
  });
});

describe('repair on a stronger sibling model (B)', () => {
  it('escalates small tiers on the same provider and never the shared key', () => {
    expect(repairModelFor('OPENAI', 'gpt-4o-mini', false)).toBe('gpt-4.1');
    expect(repairModelFor('OPENAI', 'gpt-4.1-mini', false)).toBe('gpt-4.1');
    expect(repairModelFor('OPENAI', 'gpt-4.1', false)).toBe('gpt-4.1');
    expect(repairModelFor('GEMINI', 'gemini-2.5-flash-lite', false)).toBe(
      'gemini-2.5-flash',
    );
    expect(repairModelFor('GEMINI', 'gemini-2.5-flash-lite', true)).toBe(
      'gemini-2.5-flash-lite',
    );
    expect(repairModelFor('OPENROUTER', 'openai/gpt-4o-mini', false)).toBe(
      'openai/gpt-4o-mini',
    );
  });

  it('runs the repair rounds on the escalated model and charges its tokens', async () => {
    const models: string[] = [];
    const { finalize } = serviceReplying(['Which time works?'], models);
    const r = await finalize(draft, '', 'gpt-4.1');
    expect(models).toEqual(['gpt-4.1']);
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });
});

describe('prescriptive repair text (C, D)', () => {
  const issues = checkProposal(draft, REAL_WEEK).issues;
  const all = issues.join('\n');

  it('names the split on the real Reading & Labs id for labs that landed on Book', () => {
    const tue = idsOf(REAL_WEEK, 'Reading & Labs (Core Engineering)', [2])[0];
    expect(all).toContain(
      `{"type":"SPLIT_SCHEDULE_BLOCK","id":"${tue}","expectedTitle":"Reading & Labs (Core Engineering)","payload":{"allOccurrences":true,"pieces":[{"title":"Core Engineering","minutes":60},{"title":"Soft Skills Lab","minutes":30},{"title":"Technical Challenges Lab","minutes":30}]}}`,
    );
  });

  it('points out the weekend day the proposal forgot to move', () => {
    const sat = idsOf(REAL_WEEK, 'Deep Reading', [6])[0];
    expect(all).toContain(
      'This proposal moves "Deep Reading" on Sun but not on Sat.',
    );
    expect(all).toContain(`"id":"${sat}"`);
  });

  it('never suggests splitting an unrelated block the user did not mention', () => {
    expect(all).not.toMatch(
      /SPLIT_SCHEDULE_BLOCK on id=[^ ]+ with expectedTitle "Family Time"/,
    );
    expect(all).toContain(
      '"Family Time" (Sat 5:00 AM to 6:00 AM) stays where it is.',
    );
  });

  it('names the series id and updateScope when a series member conflicts', () => {
    const book = idsOf(REAL_WEEK, 'Book', [2])[0];
    const r = checkProposal(
      JSON.stringify({
        actions: [
          {
            type: 'UPDATE_SCHEDULE_BLOCK',
            id: book,
            expectedTitle: 'Book',
            payload: { endTime: '12:00' },
          },
        ],
      }),
      // Give Book a shared series, as production has it.
      REAL_WEEK.map((b) =>
        b.title === 'Book' ? { ...b, seriesId: 'book-series' } : b,
      ),
    );
    expect(r.issues[0]).toMatch(
      /one series on Tue, Wed, Thu, Fri: .*updateScope "series" on id=/,
    );
  });

  it('asks for every part that fits plus one question, not a withheld plan', () => {
    const text = repairInstruction(['x']);
    expect(text).toContain('PROPOSE EVERY PART THAT FITS');
    expect(text).toContain('leave ONLY that part out');
    expect(text).toContain('Write nothing before the block');
  });
});
