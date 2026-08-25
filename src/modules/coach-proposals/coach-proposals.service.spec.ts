import { CoachProposalsService } from './coach-proposals.service';
import { CoachProposedAction } from './dto/apply-proposals.dto';

// Regression cover for the coach-proposal mass-assignment hole.
//
// `CoachProposedAction.payload` is typed `Record<string, any>` with a bare
// `@IsObject()`, and the global ValidationPipe's `whitelist: true` does not
// recurse into an untyped object. The payload therefore arrived at the domain
// services (which all take `any` and spread into Prisma) exactly as the caller
// sent it. `{"type":"UPDATE_GOAL","id":"<own goal>","payload":{"userId":"<someone else>"}}`
// moved the row into a stranger's account.

// Real row ids are uuids (`@default(uuid())`), and the DTOs validate the
// relation fields as uuids, so the spies have to hand back a real one for the
// "$ref:N" back-reference path to stay representative.
const CREATED_ID = '22222222-2222-4222-8222-222222222222';
const JOURNAL_ENTRY_ID = '33333333-3333-4333-8333-333333333333';
const NOTE_ID = '44444444-4444-4444-8444-444444444444';

class SpyService {
  calls: Array<{ method: string; userId: string; id?: string; dto: any }> = [];

  create = async (userId: string, dto: any) => {
    this.calls.push({ method: 'create', userId, dto });
    return { id: CREATED_ID };
  };

  update = async (userId: string, id: string, dto: any) => {
    this.calls.push({ method: 'update', userId, id, dto });
    return { id };
  };

  delete = async (userId: string, id: string) => {
    this.calls.push({ method: 'delete', userId, id, dto: undefined });
    return { message: 'deleted' };
  };

  createAccepted = async (userId: string, dto: any) => {
    this.calls.push({ method: 'createAccepted', userId, dto });
    return { id: 'insight_1' };
  };

  appendContent = async (userId: string, dto: any) => {
    this.calls.push({ method: 'appendContent', userId, dto });
    return { id: JOURNAL_ENTRY_ID };
  };

  // NotesService.appendContentByTitleHint's real signature is
  // (userId, titleHint, content) — not the (userId, dto) shape every other
  // spy method above mimics — so this is captured as its own method rather
  // than folded into a generic one. `dto` in the recorded call is
  // reconstructed as { titleHint, content } purely so assertions below can
  // read it the same way they read every other spy call.
  appendContentByTitleHint = async (
    userId: string,
    titleHint: string,
    content: string,
  ) => {
    this.calls.push({
      method: 'appendContentByTitleHint',
      userId,
      dto: { titleHint, content },
    });
    return { id: NOTE_ID };
  };
}

class FakePrisma {
  scheduleBlock = {
    // No idempotency match, so every create goes through the real path.
    findFirst: async () => null,
  };
}

function buildService() {
  const goals = new SpyService();
  const schedule = new SpyService();
  const timeEntries = new SpyService();
  const tasks = new SpyService();
  const insights = new SpyService();
  const activeTimer = new SpyService();
  const journal = new SpyService();
  const notes = new SpyService();
  const service = new CoachProposalsService(
    new FakePrisma() as any,
    goals as any,
    schedule as any,
    timeEntries as any,
    tasks as any,
    insights as any,
    activeTimer as any,
    journal as any,
    notes as any,
  );

  return {
    service,
    goals,
    schedule,
    timeEntries,
    tasks,
    insights,
    activeTimer,
    journal,
    notes,
  };
}

const OWN_GOAL = '11111111-1111-4111-8111-111111111111';
const ATTACKER = 'attacker-user-id';
const VICTIM = 'victim-user-id';

describe('CoachProposalsService payload validation', () => {
  it('rejects UPDATE_GOAL that tries to reassign the row to another user', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'UPDATE_GOAL',
        id: OWN_GOAL,
        payload: { userId: VICTIM },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('userId');
    // The service must never have been reached at all.
    expect(goals.calls).toHaveLength(0);
  });

  it.each([
    ['UPDATE_TIME_ENTRY', 'timeEntries'],
    ['UPDATE_TASK', 'tasks'],
    ['UPDATE_SCHEDULE_BLOCK', 'schedule'],
  ] as const)('rejects %s carrying a userId', async (type, serviceKey) => {
    const built = buildService();

    const results = await built.service.apply(ATTACKER, [
      { type, id: OWN_GOAL, payload: { userId: VICTIM } } as any,
    ]);

    expect(results[0].ok).toBe(false);
    expect((built as any)[serviceKey].calls).toHaveLength(0);
  });

  it('rejects CREATE_GOAL carrying a userId', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_GOAL',
        payload: {
          title: 'Ship it',
          category: 'WORK',
          targetHours: 10,
          userId: VICTIM,
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(goals.calls).toHaveLength(0);
  });

  it('rejects columns the DTO does not expose, such as loggedHours on create', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_GOAL',
        payload: {
          title: 'Ship it',
          category: 'WORK',
          targetHours: 10,
          loggedHours: 9999,
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(goals.calls).toHaveLength(0);
  });

  it('never lets an id ride in the payload, only action.id', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'UPDATE_GOAL',
        id: OWN_GOAL,
        payload: {
          title: 'Renamed',
          id: '99999999-9999-4999-8999-999999999999',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(goals.calls).toHaveLength(0);
  });

  it('rejects userId on action types that have no per-type DTO', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'RENAME_GOAL',
        id: OWN_GOAL,
        payload: { title: 'LeafCompute', userId: VICTIM },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('userId');
    expect(goals.calls).toHaveLength(0);
  });

  it('still applies a clean CREATE_PRACTICE under the caller own id', async () => {
    const { service, insights } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_PRACTICE',
        payload: { title: 'Walk daily', body: 'Ten minutes' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(true);
    expect(insights.calls[0].userId).toBe(ATTACKER);
  });

  // CREATE_PRACTICE used to be the one action type absent from
  // PAYLOAD_DTO_BY_ACTION: its payload only got the generic forbidden-key
  // strip (id/userId/user/createdAt/updatedAt), never a real DTO pass, so
  // unlike every other action type it had no forbidNonWhitelisted check and
  // no field-length ceiling. These lock in CreatePracticeDto now closing that
  // gap the same way every other action type is already covered.
  it('rejects CREATE_PRACTICE carrying a field CreatePracticeDto does not expose', async () => {
    const { service, insights } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_PRACTICE',
        payload: {
          title: 'Walk daily',
          body: 'Ten minutes',
          notARealField: 'sneaky',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('notARealField');
    expect(insights.calls).toHaveLength(0);
  });

  // The actual finding: sourceMessageId/sourceConversationId are opaque,
  // arbitrary-length, model-chosen strings that createAccepted stores
  // verbatim. CreatePracticeDto deliberately does not expose them (see the
  // class doc comment on CreatePracticeDto), so a payload trying to set
  // either one is refused outright rather than silently written.
  it.each(['sourceMessageId', 'sourceConversationId'])(
    'rejects a CREATE_PRACTICE payload that tries to set %s',
    async (field) => {
      const { service, insights } = buildService();

      const results = await service.apply(ATTACKER, [
        {
          type: 'CREATE_PRACTICE',
          payload: {
            title: 'Walk daily',
            body: 'Ten minutes',
            [field]: 'some-other-users-conversation-id',
          },
        } as CoachProposedAction,
      ]);

      expect(results[0].ok).toBe(false);
      expect(results[0].error).toContain(field);
      expect(insights.calls).toHaveLength(0);
    },
  );

  it('rejects a CREATE_PRACTICE title over the length ceiling', async () => {
    const { service, insights } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_PRACTICE',
        payload: { title: 'x'.repeat(101), body: 'Ten minutes' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(insights.calls).toHaveLength(0);
  });

  it('still applies a CREATE_PRACTICE carrying its full set of optional fields', async () => {
    const { service, insights } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_PRACTICE',
        payload: {
          title: 'Walk daily',
          body: 'Ten minutes after Asr, no phone.',
          suggestedAction: 'Put your shoes by the door tonight.',
          kind: 'EXPERIMENT',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(true);
    expect(insights.calls[0].dto).toMatchObject({
      title: 'Walk daily',
      body: 'Ten minutes after Asr, no phone.',
      suggestedAction: 'Put your shoes by the door tonight.',
      kind: 'EXPERIMENT',
    });
    // The whitelist is the whole point: nothing beyond CreatePracticeDto's own
    // fields reaches the service, no matter what the caller sent alongside.
    expect(insights.calls[0].dto.sourceMessageId).toBeUndefined();
    expect(insights.calls[0].dto.sourceConversationId).toBeUndefined();
  });

  // The journal action is the newest write surface the Coach has, and the one
  // whose payload looks most innocuous (no ids at all, just prose), so it gets
  // the same cross-account cover every other action type has. The only thing
  // standing between "append to my journal" and "append to someone else's" is
  // that `userId` comes from the JWT and can never come from the payload.
  it('rejects APPEND_JOURNAL_ENTRY that tries to write into another user journal', async () => {
    const { service, journal } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_JOURNAL_ENTRY',
        payload: { content: 'Planted evidence.', userId: VICTIM },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('userId');
    // Not "wrote to the caller's own row instead" — the action fails outright
    // and the journal service is never reached.
    expect(journal.calls).toHaveLength(0);
  });

  it('rejects an APPEND_JOURNAL_ENTRY payload carrying an entry id', async () => {
    const { service, journal } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_JOURNAL_ENTRY',
        payload: {
          content: 'Hello',
          id: '99999999-9999-4999-8999-999999999999',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(journal.calls).toHaveLength(0);
  });

  it('rejects fields AppendJournalContentDto does not expose, such as mood', async () => {
    const { service, journal } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_JOURNAL_ENTRY',
        payload: { content: 'Hello', mood: 5 },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('mood');
    expect(journal.calls).toHaveLength(0);
  });

  it('rejects an APPEND_JOURNAL_ENTRY with a malformed date', async () => {
    const { service, journal } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_JOURNAL_ENTRY',
        payload: { content: 'Hello', date: 'yesterday' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(journal.calls).toHaveLength(0);
  });

  it('rejects an APPEND_JOURNAL_ENTRY with nothing but whitespace to add', async () => {
    const { service, journal } = buildService();

    const results = await service.apply(ATTACKER, [
      { type: 'APPEND_JOURNAL_ENTRY', payload: { content: '   ' } } as any,
    ]);

    expect(results[0].ok).toBe(false);
    expect(journal.calls).toHaveLength(0);
  });

  // APPEND_NOTE_CONTENT has no `id` field at all (see AppendNoteContentDto's
  // doc comment: the Coach is never given note titles/ids, so matching
  // happens server-side against `titleHint`). The mass-assignment surface is
  // still the same shape as every other action here — a payload smuggling
  // `userId` must be refused before NotesService is ever reached.
  it('rejects APPEND_NOTE_CONTENT carrying a userId', async () => {
    const { service, notes } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_NOTE_CONTENT',
        payload: {
          titleHint: 'research papers',
          content: 'read about dynamo',
          userId: VICTIM,
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('userId');
    expect(notes.calls).toHaveLength(0);
  });

  it('rejects APPEND_NOTE_CONTENT carrying a note id', async () => {
    const { service, notes } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_NOTE_CONTENT',
        payload: {
          titleHint: 'research papers',
          content: 'read about dynamo',
          id: '99999999-9999-4999-8999-999999999999',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(notes.calls).toHaveLength(0);
  });

  it('rejects fields AppendNoteContentDto does not expose', async () => {
    const { service, notes } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_NOTE_CONTENT',
        payload: {
          titleHint: 'research papers',
          content: 'read about dynamo',
          parentId: 'some-other-note',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('parentId');
    expect(notes.calls).toHaveLength(0);
  });

  it('rejects an APPEND_NOTE_CONTENT missing titleHint', async () => {
    const { service, notes } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_NOTE_CONTENT',
        payload: { content: 'read about dynamo' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(notes.calls).toHaveLength(0);
  });

  it('rejects an APPEND_NOTE_CONTENT with nothing but whitespace to add', async () => {
    const { service, notes } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_NOTE_CONTENT',
        payload: { titleHint: 'research papers', content: '   ' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(notes.calls).toHaveLength(0);
  });

  it('one poisoned action does not stop the legitimate ones in the batch', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      { type: 'UPDATE_GOAL', id: OWN_GOAL, payload: { userId: VICTIM } } as any,
      { type: 'UPDATE_GOAL', id: OWN_GOAL, payload: { title: 'Fine' } } as any,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
    expect(goals.calls).toHaveLength(1);
    expect(goals.calls[0].dto.title).toBe('Fine');
  });
});

describe('CoachProposalsService still applies legitimate proposals', () => {
  it('applies a normal UPDATE_GOAL', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'UPDATE_GOAL',
        id: OWN_GOAL,
        payload: {
          title: 'New title',
          targetHours: 20,
          deadline: '2026-09-01',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(true);
    expect(goals.calls[0].userId).toBe(ATTACKER);
    expect(goals.calls[0].dto.title).toBe('New title');
    expect(goals.calls[0].dto.targetHours).toBe(20);
  });

  it('applies RENAME_GOAL', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'RENAME_GOAL',
        id: OWN_GOAL,
        payload: { title: '  LeafCompute  ' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(true);
    expect(goals.calls[0].dto).toEqual({ title: 'LeafCompute' });
  });

  it('still fans a multi-day CREATE_SCHEDULE_BLOCK into one series', async () => {
    const { service, schedule } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_SCHEDULE_BLOCK',
        payload: {
          title: 'Deep Work',
          startTime: '09:00',
          endTime: '12:00',
          category: 'DEEP_WORK',
          daysOfWeek: [1, 2, 3],
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(true);
    expect(schedule.calls).toHaveLength(3);
    expect(schedule.calls.map((c) => c.dto.dayOfWeek)).toEqual([1, 2, 3]);
    const seriesIds = new Set(schedule.calls.map((c) => c.dto.seriesId));
    expect(seriesIds.size).toBe(1);
    expect(schedule.calls[0].dto.userId).toBeUndefined();
  });

  it('still creates a single-day CREATE_SCHEDULE_BLOCK', async () => {
    const { service, schedule } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_SCHEDULE_BLOCK',
        payload: {
          title: 'Deep Work',
          startTime: '09:00',
          endTime: '12:00',
          category: 'DEEP_WORK',
          dayOfWeek: 4,
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(true);
    expect(schedule.calls).toHaveLength(1);
    expect(schedule.calls[0].dto.dayOfWeek).toBe(4);
  });

  it('rejects a multi-day CREATE_SCHEDULE_BLOCK that smuggles a userId', async () => {
    const { service, schedule } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_SCHEDULE_BLOCK',
        payload: {
          title: 'Deep Work',
          startTime: '09:00',
          endTime: '12:00',
          category: 'DEEP_WORK',
          daysOfWeek: [1, 2],
          userId: VICTIM,
        },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(schedule.calls).toHaveLength(0);
  });

  it('applies APPEND_JOURNAL_ENTRY under the caller own id, with no date defaulting handled here', async () => {
    const { service, journal } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_JOURNAL_ENTRY',
        payload: { content: 'Felt scattered all afternoon.' },
      } as CoachProposedAction,
    ]);

    expect(results[0]).toMatchObject({ ok: true, resultId: JOURNAL_ENTRY_ID });
    expect(journal.calls).toHaveLength(1);
    // The one thing that must never come from the payload. The `date`
    // fallback deliberately lives in CoachJournalService, not here.
    expect(journal.calls[0].userId).toBe(ATTACKER);
    expect(journal.calls[0].dto).toEqual({
      content: 'Felt scattered all afternoon.',
    });
  });

  it('passes an explicit date through to the journal service unchanged', async () => {
    const { service, journal } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_JOURNAL_ENTRY',
        payload: { content: 'Monday was better.', date: '2026-08-10' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(true);
    expect(journal.calls[0].dto).toEqual({
      content: 'Monday was better.',
      date: '2026-08-10',
    });
  });

  it('applies APPEND_NOTE_CONTENT by dispatching to NotesService with the trimmed titleHint and content', async () => {
    const { service, notes } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_NOTE_CONTENT',
        payload: {
          titleHint: '  research papers  ',
          content: '  read about dynamo  ',
        },
      } as CoachProposedAction,
    ]);

    expect(results[0]).toMatchObject({ ok: true, resultId: NOTE_ID });
    expect(notes.calls).toHaveLength(1);
    expect(notes.calls[0].userId).toBe(ATTACKER);
    // Matching happens inside NotesService (title-hint resolution, never an
    // id from the payload) — this only proves the proposals service handed
    // it the right, trimmed inputs under the caller's own id.
    expect(notes.calls[0].dto).toEqual({
      titleHint: 'research papers',
      content: 'read about dynamo',
    });
  });

  // NotesService.appendContentByTitleHint throws BadRequestException for an
  // ambiguous or absent title match (see notes.service.spec.ts for the
  // matching-tier coverage itself). This proves that failure surfaces as a
  // per-action error on the result — the same "no silent failure, no
  // guessing" path every other action's apply-time errors already take —
  // rather than the batch throwing outright or the action reporting success.
  it("surfaces NotesService's no-match/ambiguous message as this action's error, without touching the batch's other actions", async () => {
    const { service, notes, goals } = buildService();
    const { BadRequestException } = jest.requireActual('@nestjs/common');
    notes.appendContentByTitleHint = async () => {
      throw new BadRequestException(
        'Couldn\'t find a page titled "research papers" to add to.',
      );
    };

    const results = await service.apply(ATTACKER, [
      {
        type: 'APPEND_NOTE_CONTENT',
        payload: { titleHint: 'research papers', content: 'x' },
      } as CoachProposedAction,
      {
        type: 'RENAME_GOAL',
        id: OWN_GOAL,
        payload: { title: 'Still works' },
      } as CoachProposedAction,
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('research papers');
    expect(results[1]).toMatchObject({ ok: true });
    expect(goals.calls).toHaveLength(1);
  });

  it('still resolves $ref tokens across actions in one batch', async () => {
    const { service, schedule } = buildService();

    const results = await service.apply(ATTACKER, [
      {
        type: 'CREATE_GOAL',
        payload: { title: 'Learn Rust', category: 'LEARNING', targetHours: 40 },
      } as CoachProposedAction,
      {
        type: 'CREATE_SCHEDULE_BLOCK',
        payload: {
          title: 'Rust',
          startTime: '07:00',
          endTime: '08:00',
          category: 'LEARNING',
          dayOfWeek: 2,
          goalId: '$ref:0',
        },
      } as CoachProposedAction,
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(schedule.calls[0].dto.goalId).toBe(CREATED_ID);
  });
});

/**
 * End-to-end cover for the bulk-delete regression. On a real account the
 * Coach answered "remove goals which are not connected to current schedule and
 * progress is 0" with 15 DELETE_GOAL actions, all correct, and apply() threw a
 * 400 before touching a single one.
 */
describe('CoachProposalsService bulk deletes', () => {
  const bulkGoalIds = Array.from(
    { length: 15 },
    (_, i) => `${OWN_GOAL.slice(0, -2)}${String(i).padStart(2, '0')}`,
  );
  const bulkDeletes = bulkGoalIds.map(
    (id) => ({ type: 'DELETE_GOAL', id }) as CoachProposedAction,
  );

  it('refuses 15 unconfirmed goal deletes without dispatching any of them', async () => {
    const { service, goals } = buildService();

    await expect(service.apply(ATTACKER, bulkDeletes)).rejects.toThrow(
      /15 delete actions/,
    );
    expect(goals.calls).toHaveLength(0);
  });

  it('applies all 15 when the client confirms every id', async () => {
    const { service, goals } = buildService();

    const results = await service.apply(ATTACKER, bulkDeletes, {
      confirmedDeleteIds: bulkGoalIds,
    });

    expect(results).toHaveLength(15);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(goals.calls.map((c) => c.id)).toEqual(bulkGoalIds);
    expect(goals.calls.every((c) => c.userId === ATTACKER)).toBe(true);
  });

  it('refuses the whole batch when one delete is missing from the confirmations', async () => {
    const { service, goals } = buildService();

    await expect(
      service.apply(ATTACKER, bulkDeletes, {
        confirmedDeleteIds: bulkGoalIds.slice(0, 14),
      }),
    ).rejects.toThrow(/not individually confirmed/);
    expect(goals.calls).toHaveLength(0);
  });
});
