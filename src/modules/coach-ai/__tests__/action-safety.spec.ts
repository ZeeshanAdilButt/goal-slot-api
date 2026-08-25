import { BadRequestException } from '@nestjs/common';

import {
  DESTRUCTIVE_COACH_ACTION_TYPES,
  assertProposalBatchSafe,
  isDestructiveActionType,
  maxDestructiveActionsPerBatch,
  maxGoalDeletionsPerBatch,
} from '../safety/action-safety';
import {
  COACH_ACTION_TYPES,
  CoachActionType,
  CoachProposedAction,
} from '../../coach-proposals/dto/apply-proposals.dto';

const ENV_KEYS = [
  'COACH_MAX_DESTRUCTIVE_ACTIONS',
  'COACH_MAX_GOAL_DELETIONS',
  'COACH_REQUIRE_DELETE_CONFIRMATION',
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function action(
  type: CoachActionType,
  id?: string,
  payload?: Record<string, any>,
): CoachProposedAction {
  return { type, id, payload } as CoachProposedAction;
}

function deletes(type: CoachActionType, n: number): CoachProposedAction[] {
  return Array.from({ length: n }, (_, i) => action(type, `${type}_${i}`));
}

describe('destructive action classification', () => {
  it('flags exactly the four DELETE_* types', () => {
    const flagged = COACH_ACTION_TYPES.filter((t) =>
      isDestructiveActionType(t),
    );
    expect([...flagged].sort()).toEqual(
      [...DESTRUCTIVE_COACH_ACTION_TYPES].sort(),
    );
    expect(flagged).toHaveLength(4);
  });

  it('does not flag creates, updates, or renames', () => {
    expect(isDestructiveActionType('CREATE_GOAL')).toBe(false);
    expect(isDestructiveActionType('UPDATE_SCHEDULE_BLOCK')).toBe(false);
    expect(isDestructiveActionType('RENAME_GOAL')).toBe(false);
    expect(isDestructiveActionType('CREATE_PRACTICE')).toBe(false);
  });
});

describe('assertProposalBatchSafe: normal proposals still pass', () => {
  it('allows a large non-destructive bundle (goal + practice + a full week)', () => {
    const batch: CoachProposedAction[] = [
      action('CREATE_GOAL', undefined, { title: 'Daily Quran' }),
      action('CREATE_PRACTICE', undefined, { title: 'Read 5 ayat' }),
      ...Array.from({ length: 60 }, () =>
        action('CREATE_SCHEDULE_BLOCK', undefined, {
          title: 'Quran',
          goalId: '$ref:0',
        }),
      ),
    ];
    expect(() => assertProposalBatchSafe(batch)).not.toThrow();
  });

  it('allows a handful of deletes, which is what real tidy-ups look like', () => {
    expect(() =>
      assertProposalBatchSafe([
        ...deletes('DELETE_SCHEDULE_BLOCK', 4),
        action('UPDATE_GOAL', 'g_1', { targetHours: 10 }),
      ]),
    ).not.toThrow();
  });

  it('allows an empty-ish batch with no deletes at all', () => {
    expect(() =>
      assertProposalBatchSafe([action('RENAME_GOAL', 'g_1', { title: 'x' })]),
    ).not.toThrow();
  });
});

describe('assertProposalBatchSafe: destructive caps', () => {
  it('defaults to 10 total deletes and 3 goal deletes', () => {
    expect(maxDestructiveActionsPerBatch()).toBe(10);
    expect(maxGoalDeletionsPerBatch()).toBe(3);
  });

  it('rejects a batch over the total delete cap', () => {
    expect(() =>
      assertProposalBatchSafe(deletes('DELETE_TIME_ENTRY', 11)),
    ).toThrow(BadRequestException);
  });

  it('names the count and the cap so the UI can explain the refusal', () => {
    try {
      assertProposalBatchSafe(deletes('DELETE_TIME_ENTRY', 25));
      throw new Error('expected a rejection');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain('25');
      expect(err.message).toContain('10');
    }
  });

  it('caps goal deletions harder than other deletions', () => {
    // 4 goal deletes is under the total cap of 10 but over the goal cap of 3.
    expect(() => assertProposalBatchSafe(deletes('DELETE_GOAL', 4))).toThrow(
      /deletes 4 goals/,
    );
    expect(() =>
      assertProposalBatchSafe(deletes('DELETE_GOAL', 3)),
    ).not.toThrow();
  });

  it('counts deletes across all four types toward the total cap', () => {
    const mixed = [
      ...deletes('DELETE_GOAL', 3),
      ...deletes('DELETE_TASK', 3),
      ...deletes('DELETE_SCHEDULE_BLOCK', 3),
      ...deletes('DELETE_TIME_ENTRY', 3),
    ];
    expect(mixed).toHaveLength(12);
    expect(() => assertProposalBatchSafe(mixed)).toThrow(/12 delete actions/);
  });

  it('honours operator overrides from env, read at call time not at boot', () => {
    process.env.COACH_MAX_DESTRUCTIVE_ACTIONS = '2';
    expect(maxDestructiveActionsPerBatch()).toBe(2);
    expect(() => assertProposalBatchSafe(deletes('DELETE_TASK', 3))).toThrow();

    process.env.COACH_MAX_DESTRUCTIVE_ACTIONS = '50';
    expect(() =>
      assertProposalBatchSafe(deletes('DELETE_TASK', 3)),
    ).not.toThrow();
  });

  it('falls back to the default when the env var is garbage', () => {
    process.env.COACH_MAX_DESTRUCTIVE_ACTIONS = 'not-a-number';
    expect(maxDestructiveActionsPerBatch()).toBe(10);
  });
});

describe('assertProposalBatchSafe: per-item delete confirmation', () => {
  const batch = [
    action('CREATE_GOAL', undefined, { title: 'new' }),
    action('DELETE_SCHEDULE_BLOCK', 'b_1'),
    action('DELETE_SCHEDULE_BLOCK', 'b_2'),
  ];

  it('is not required by default, so existing clients keep working', () => {
    expect(() => assertProposalBatchSafe(batch)).not.toThrow();
  });

  it('passes when every delete id is confirmed', () => {
    expect(() =>
      assertProposalBatchSafe(batch, { confirmedDeleteIds: ['b_1', 'b_2'] }),
    ).not.toThrow();
  });

  it('rejects when a delete rides along unconfirmed', () => {
    expect(() =>
      assertProposalBatchSafe(batch, { confirmedDeleteIds: ['b_1'] }),
    ).toThrow(/not individually confirmed/);
  });

  it('treats an empty confirmation list as strict, not as absent', () => {
    expect(() =>
      assertProposalBatchSafe(batch, { confirmedDeleteIds: [] }),
    ).toThrow(/not individually confirmed/);
  });

  it('becomes mandatory once the operator flips the flag on', () => {
    process.env.COACH_REQUIRE_DELETE_CONFIRMATION = 'true';
    expect(() => assertProposalBatchSafe(batch)).toThrow(
      /not individually confirmed/,
    );
    expect(() =>
      assertProposalBatchSafe(batch, { confirmedDeleteIds: ['b_1', 'b_2'] }),
    ).not.toThrow();
  });

  it('rejects a delete with no id at all under strict mode', () => {
    process.env.COACH_REQUIRE_DELETE_CONFIRMATION = 'true';
    expect(() =>
      assertProposalBatchSafe([action('DELETE_GOAL', undefined)]),
    ).toThrow(/not individually confirmed/);
  });
});

/**
 * Regression: "remove the goals that aren't linked to any schedule block" is a
 * normal thing to ask the Coach, and on a real account it produced a proposal
 * of 15 DELETE_GOAL actions. The card listed the right 15 goals, and Apply
 * came back 400 because the count caps refused the whole batch. Same shape
 * refused a 35-block and a 13-time-entry cleanup on other accounts.
 */
describe('assertProposalBatchSafe: confirmed bulk cleanup', () => {
  const bulkGoalCleanup = deletes('DELETE_GOAL', 15);
  const confirmedIds = bulkGoalCleanup.map((a) => a.id as string);

  it('still refuses the 15-goal cleanup when nothing was confirmed', () => {
    expect(() => assertProposalBatchSafe(bulkGoalCleanup)).toThrow(
      /15 delete actions/,
    );
  });

  it('applies the 15-goal cleanup once every id is confirmed', () => {
    expect(() =>
      assertProposalBatchSafe(bulkGoalCleanup, {
        confirmedDeleteIds: confirmedIds,
      }),
    ).not.toThrow();
  });

  it('applies a 35-block cleanup once every id is confirmed', () => {
    const blocks = deletes('DELETE_SCHEDULE_BLOCK', 35);
    expect(() => assertProposalBatchSafe(blocks)).toThrow(BadRequestException);
    expect(() =>
      assertProposalBatchSafe(blocks, {
        confirmedDeleteIds: blocks.map((a) => a.id as string),
      }),
    ).not.toThrow();
  });

  it('does not let confirmations wave through a delete the user never saw', () => {
    const smuggled = [...bulkGoalCleanup, action('DELETE_TASK', 't_hidden')];
    expect(() =>
      assertProposalBatchSafe(smuggled, { confirmedDeleteIds: confirmedIds }),
    ).toThrow(/not individually confirmed/);
  });

  it('still walks payload shape on a confirmed batch', () => {
    const wide: Record<string, any> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i;
    expect(() =>
      assertProposalBatchSafe([action('DELETE_GOAL', 'g_1', wide)], {
        confirmedDeleteIds: ['g_1'],
      }),
    ).toThrow(/more than 2000 fields/);
  });

  it('keeps the goal cap on an unconfirmed batch that is under the total cap', () => {
    expect(() => assertProposalBatchSafe(deletes('DELETE_GOAL', 5))).toThrow(
      /deletes 5 goals/,
    );
    expect(() =>
      assertProposalBatchSafe(deletes('DELETE_GOAL', 5), {
        confirmedDeleteIds: deletes('DELETE_GOAL', 5).map(
          (a) => a.id as string,
        ),
      }),
    ).not.toThrow();
  });
});

describe('assertProposalBatchSafe: adversarial payload shapes', () => {
  it('rejects a payload nested deeper than the walker will follow', () => {
    let deep: any = { end: true };
    for (let i = 0; i < 5000; i++) deep = { next: deep };
    expect(() =>
      assertProposalBatchSafe([action('UPDATE_GOAL', 'g_1', deep)]),
    ).toThrow(/nested deeper/);
  });

  it('rejects an absurdly wide payload before anything is dispatched', () => {
    const wide: Record<string, any> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i;
    expect(() =>
      assertProposalBatchSafe([action('UPDATE_GOAL', 'g_1', wide)]),
    ).toThrow(/more than 2000 fields/);
  });

  it('does not choke on a deeply nested payload delivered as arrays', () => {
    let deep: any = ['leaf'];
    for (let i = 0; i < 5000; i++) deep = [deep];
    expect(() =>
      assertProposalBatchSafe([action('UPDATE_GOAL', 'g_1', { deep })]),
    ).toThrow(BadRequestException);
  });

  it('accepts the nesting a real proposal payload uses', () => {
    expect(() =>
      assertProposalBatchSafe([
        action('CREATE_SCHEDULE_BLOCK', undefined, {
          title: 'Deep work',
          startTime: '09:00',
          endTime: '10:30',
          daysOfWeek: [1, 2, 3, 4, 5],
          goalId: '$ref:0',
        }),
      ]),
    ).not.toThrow();
  });

  it('tolerates a missing payload', () => {
    expect(() =>
      assertProposalBatchSafe([action('DELETE_TASK', 't_1')]),
    ).not.toThrow();
  });
});
