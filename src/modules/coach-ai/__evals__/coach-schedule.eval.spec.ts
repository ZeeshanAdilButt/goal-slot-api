import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { CoachProvider } from '@prisma/client';
import { LlmFactory } from '../../../shared/services/llm/llm-factory';
import { messagesFor, parseReply, universalChecks } from './harness';
import { Scenario, SCENARIOS } from './scenarios';

/**
 * Coach schedule-editing scenario eval.
 *
 * Feeds the exact production prompt (system prompt, context message built by
 * buildCoachChatMessages, conversation) for each scenario to a model, then
 * checks properties of what came back: deletes and updates use ids that are
 * really in the context, with the title they claim; the batch would pass the
 * apply preflight; new blocks land in the target block's slot; recurring
 * blocks are handled on every day they occur; and the prose does not claim
 * to store things the data model cannot.
 *
 * Two modes:
 *   - Default (every `npm test`): replays recorded model replies from
 *     recordings/<model>/<scenario>.json. Free, deterministic, and still
 *     catches a prompt or context change that breaks what the checks expect
 *     of the parser and planner.
 *   - Live, opt-in: re-asks the model and rewrites the recordings.
 *       COACH_EVAL_LIVE=1 COACH_EVAL_PROVIDER=GEMINI \
 *       COACH_EVAL_MODELS=gemini-2.5-flash,gemini-2.0-flash-lite \
 *       COACH_EVAL_API_KEY=... npx jest coach-schedule.eval
 *     Costs a few cents per model per run (about 14 calls of ~20k tokens).
 *
 * Models in GATING must pass every scenario they have a recording for; any other
 * recorded model is reported as a pass rate but does not fail the suite, so a
 * weaker model's score is visible without blocking.
 */

const LIVE = process.env.COACH_EVAL_LIVE === '1';
const PROVIDER = (process.env.COACH_EVAL_PROVIDER ?? 'GEMINI') as CoachProvider;
const RECORDINGS = join(__dirname, 'recordings');
const GATING = ['gemini-2.5-flash'];

function recordedModels(): string[] {
  if (!existsSync(RECORDINGS)) return [];
  return readdirSync(RECORDINGS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

const MODELS = LIVE
  ? (process.env.COACH_EVAL_MODELS ?? 'gemini-2.5-flash')
      .split(',')
      .map((m) => m.trim())
  : recordedModels();

function recordingPath(model: string, id: string) {
  return join(RECORDINGS, model.replace(/[^a-zA-Z0-9.-]/g, '_'), `${id}.json`);
}

// Free-tier keys allow ~5 requests a minute per model, so live calls are
// spaced out and a 429/503 is retried after a pause instead of failing.
const PACE_MS = Number(process.env.COACH_EVAL_PACE_MS ?? 13_000);
let lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(model: string, s: Scenario): Promise<string> {
  const key = process.env.COACH_EVAL_API_KEY;
  if (!key) throw new Error('COACH_EVAL_API_KEY is required in live mode');
  const provider = new LlmFactory().create(PROVIDER, key);
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      let text = '';
      for await (const chunk of provider.streamCompletion(
        messagesFor(s.blocks, s.turns, s.applyNotes),
        model,
      )) {
        text += chunk.delta;
      }
      return text;
    } catch (err) {
      const retryable = /\b(429|503)\b/.test(String(err));
      if (!retryable || attempt >= 4) throw err;
      await sleep(30_000);
    }
  }
}

/** Live mode with COACH_EVAL_ONLY_FAILING=1 re-asks only missing or failing scenarios. */
const ONLY_FAILING = process.env.COACH_EVAL_ONLY_FAILING === '1';

export function evaluate(s: Scenario, text: string): string[] {
  const r = parseReply(text);
  const failures: string[] = [];
  if (s.expectProposal === true && r.proposals.length === 0) {
    failures.push(
      'expected a proposal in this reply, got prose only (asked instead of acting?)',
    );
  }
  if (s.expectProposal === false && r.proposals.length > 0) {
    failures.push('expected no proposal');
  }
  if (r.proposals.length > 0) failures.push(...universalChecks(s.blocks, r));
  if (r.proposals.length > 0 || s.expectProposal !== true) {
    failures.push(...s.check(r, s.blocks));
  }
  return failures;
}

const scoreboard = new Map<
  string,
  { pass: number; total: number; failed: string[] }
>();

afterAll(() => {
  for (const [model, s] of scoreboard) {
    // eslint-disable-next-line no-console
    console.log(
      `Coach schedule eval ${model}: ${s.pass}/${s.total} scenarios pass` +
        (s.failed.length ? `; failing: ${s.failed.join(', ')}` : ''),
    );
  }
});

if (MODELS.length === 0) {
  it.skip('no recorded models yet; run in live mode to record', () =>
    undefined);
}

for (const model of MODELS) {
  const gating = GATING.includes(model);
  describe(`Coach schedule scenarios (${model}${gating ? '' : ', informational'})`, () => {
    const board = { pass: 0, total: 0, failed: [] as string[] };
    scoreboard.set(model, board);

    for (const s of SCENARIOS) {
      it(
        `${s.id}: ${s.description}`,
        async () => {
          const file = recordingPath(model, s.id);
          let text: string;
          const existing =
            existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).text;
          if (
            LIVE &&
            !(ONLY_FAILING && existing && evaluate(s, existing).length === 0)
          ) {
            text = await ask(model, s);
            mkdirSync(join(file, '..'), { recursive: true });
            writeFileSync(
              file,
              JSON.stringify(
                {
                  scenario: s.id,
                  model,
                  recordedAt: new Date().toISOString(),
                  text,
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            if (!existing) {
              // Not recorded yet (e.g. the provider rate-limited the last live
              // run). Reported, not failed: a missing recording says nothing
              // about the Coach. Re-record with COACH_EVAL_ONLY_FAILING=1.
              // eslint-disable-next-line no-console
              console.warn(
                `no recording for ${model}/${s.id}; run live mode to record it`,
              );
              return;
            }
            text = existing;
          }
          const failures = evaluate(s, text);
          board.total++;
          if (failures.length === 0) board.pass++;
          else board.failed.push(s.id);
          if (s.knownFailure && !LIVE) {
            if (failures.length === 0) {
              throw new Error(
                `${s.id} is marked knownFailure but its recording now passes; remove the marker`,
              );
            }
            // eslint-disable-next-line no-console
            console.warn(
              [
                `known failure ${model}/${s.id}: ${s.knownFailure}`,
                ...failures,
              ].join('\n  '),
            );
            return;
          }
          if (gating || LIVE) {
            expect(failures).toEqual([]);
          }
        },
        LIVE ? 180_000 : 5_000,
      );
    }
  });
}
