import { ForbiddenException } from '@nestjs/common';
import { NotesService } from './notes.service';

// Regression cover for a missing parent-ownership check on the notes
// tree. create/update/reorder all took a client-supplied `parentId`
// and, before this fix, wrote it straight onto the note without ever
// confirming the target parent belonged to the caller. That let a
// client reparent (or newly attach) its own note underneath a
// stranger's note id, and doubled as an existence oracle for note ids
// across accounts (404 for a made-up id vs 403 for a real one owned
// by someone else).

const OWNER = 'owner-user-id';
const STRANGER = 'stranger-user-id';
const OWNER_NOTE = 'owner-note-id';
const STRANGER_NOTE = 'stranger-note-id';
const MOVED_NOTE = 'stranger-moved-note-id';

class FakePrisma {
  updates: any[] = [];
  updateManyCalls: any[] = [];
  creates: any[] = [];
  findUniqueArgs: any[] = [];

  private notesById: Record<string, any> = {
    [OWNER_NOTE]: { id: OWNER_NOTE, userId: OWNER, parentId: null },
    [STRANGER_NOTE]: { id: STRANGER_NOTE, userId: STRANGER, parentId: null },
    [MOVED_NOTE]: { id: MOVED_NOTE, userId: STRANGER, parentId: null },
  };

  note = {
    findUnique: async ({ where }: any) => {
      this.findUniqueArgs.push(where);
      return this.notesById[where.id] ?? null;
    },
    findMany: async ({ where }: any = {}) => {
      const ids: string[] | undefined = where?.id?.in;
      if (!ids) return [];
      return ids
        .map((id: string) => this.notesById[id])
        .filter((note: any) => note !== undefined);
    },
    aggregate: async () => ({ _max: { order: null } }),
    create: async (args: any) => {
      this.creates.push(args);
      return { id: 'new-note-id', ...args.data };
    },
    update: async (args: any) => {
      this.updates.push(args);
      return args;
    },
    updateMany: async (args: any) => {
      this.updateManyCalls.push(args);
      return { count: args.where.userId === STRANGER ? 0 : 1 };
    },
  };

  $transaction = async (ops: any[]) => Promise.all(ops);
}

function buildService() {
  const prisma = new FakePrisma();
  const service = new NotesService(prisma as any, {} as any);
  return { prisma, service };
}

describe('NotesService parent-ownership scope', () => {
  it('create rejects a parentId owned by a stranger', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.create(STRANGER, {
        title: 'hijacked child',
        parentId: OWNER_NOTE,
      } as any),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.creates).toHaveLength(0);
  });

  it('create succeeds when the parentId belongs to the caller', async () => {
    const { prisma, service } = buildService();

    await service.create(OWNER, {
      title: 'legit child',
      parentId: OWNER_NOTE,
    } as any);

    expect(prisma.creates).toHaveLength(1);
  });

  it('update rejects reparenting under a note owned by a stranger', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.update(OWNER_NOTE, OWNER, { parentId: STRANGER_NOTE } as any),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.updates).toHaveLength(0);
  });

  it('reorder rejects moving a note under a stranger-owned parentId', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.reorder(STRANGER, [
        { noteId: MOVED_NOTE, parentId: OWNER_NOTE, order: 0 },
      ]),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.updateManyCalls).toHaveLength(0);
  });

  it('reorder succeeds when the target parentId belongs to the caller', async () => {
    const { prisma, service } = buildService();

    const result = await service.reorder(OWNER, [
      { noteId: OWNER_NOTE, parentId: null, order: 0 },
    ]);

    expect(result).toEqual({ success: true });
    expect(prisma.updateManyCalls).toHaveLength(1);
  });

  it('update rejects content past the length ceiling and writes nothing', async () => {
    const { prisma, service } = buildService();

    await expect(
      service.update(OWNER_NOTE, OWNER, {
        content: 'x'.repeat(65536),
      } as any),
    ).rejects.toThrow(/65535-character limit/i);

    expect(prisma.updates).toHaveLength(0);
  });
});

// Integration cover for NotesService.appendContentByTitleHint — the method
// backing the Coach's APPEND_NOTE_CONTENT proposal action (see
// coach-proposals.service.ts). matchNotesByTitle's own tiering (exact,
// substring, ambiguous, no-match) is unit-tested directly in
// note-content.spec.ts; these tests cover the service-level plumbing around
// it: scoping candidates to the caller's own notes, actually writing the
// appended content, and turning a non-'resolved' match into the
// BadRequestException the proposal-apply flow surfaces to the user.
describe('NotesService.appendContentByTitleHint', () => {
  const CALLER = 'caller-user-id';
  const OTHER = 'other-user-id';

  class AppendFakePrisma {
    updates: any[] = [];
    /** Every `select` the candidate findMany asked for, so a test can assert
     *  the matching step never pulls note bodies. */
    findManySelects: any[] = [];
    notes: Array<{ id: string; userId: string; title: string; content: string }> = [];

    /** Honours `select` the way Prisma does — returning a column the caller
     *  did not ask for would hide exactly the regression this guards. */
    private project(n: any, select: any) {
      if (!select) return { ...n };
      const out: any = {};
      for (const k of Object.keys(select)) if (select[k]) out[k] = n[k];
      return out;
    }

    note = {
      findMany: async ({ where, select }: any) => {
        this.findManySelects.push(select);
        return this.notes
          .filter((n) => n.userId === where.userId)
          .map((n) => this.project(n, select));
      },
      findFirst: async ({ where, select }: any) => {
        const row = this.notes.find(
          (n) =>
            n.id === where.id &&
            (where.userId === undefined || n.userId === where.userId),
        );
        return row ? this.project(row, select) : null;
      },
      update: async ({ where, data }: any) => {
        this.updates.push({ where, data });
        const row = this.notes.find((n) => n.id === where.id);
        if (row) row.content = data.content;
        return row;
      },
    };
  }

  function buildAppendService(
    seed: Array<{ id: string; userId: string; title: string; content: string }>,
  ) {
    const prisma = new AppendFakePrisma();
    prisma.notes = seed;
    const service = new NotesService(prisma as any, {} as any);
    return { prisma, service };
  }

  it('appends to the single note whose title matches, scoped to the caller', async () => {
    const { prisma, service } = buildAppendService([
      { id: 'n1', userId: CALLER, title: 'Research Papers', content: '<p>Existing</p>' },
      // Same title, but owned by someone else — must never be reachable.
      { id: 'n2', userId: OTHER, title: 'Research Papers', content: '<p>Not yours</p>' },
    ]);

    const updated = await service.appendContentByTitleHint(
      CALLER,
      'research papers',
      'read about dynamo',
    );

    expect(updated?.id).toBe('n1');
    expect(prisma.updates).toEqual([
      {
        where: { id: 'n1' },
        data: { content: '<p>Existing</p><p>read about dynamo</p>' },
      },
    ]);
  });

  it('starts a fresh paragraph when the matched note was empty', async () => {
    const { service } = buildAppendService([
      { id: 'n1', userId: CALLER, title: 'Ideas', content: '[]' },
    ]);

    const updated = await service.appendContentByTitleHint(
      CALLER,
      'ideas',
      'ship the v2 onboarding flow',
    );

    expect((updated as any)?.content).toBe(
      '<p>ship the v2 onboarding flow</p>',
    );
  });

  it('escapes markup in the appended text', async () => {
    const { service } = buildAppendService([
      { id: 'n1', userId: CALLER, title: 'Ideas', content: '<p>Existing</p>' },
    ]);

    const updated = await service.appendContentByTitleHint(
      CALLER,
      'ideas',
      '<b>urgent</b> follow up',
    );

    expect((updated as any)?.content).toBe(
      '<p>Existing</p><p>&lt;b&gt;urgent&lt;/b&gt; follow up</p>',
    );
  });

  it('rejects with a clear message and writes nothing when no note matches', async () => {
    const { prisma, service } = buildAppendService([
      { id: 'n1', userId: CALLER, title: 'Groceries', content: '' },
    ]);

    await expect(
      service.appendContentByTitleHint(CALLER, 'research papers', 'x'),
    ).rejects.toThrow(/couldn't find a page titled "research papers"/i);
    expect(prisma.updates).toHaveLength(0);
  });

  it('rejects with a clear message and writes nothing when the hint is ambiguous', async () => {
    const { prisma, service } = buildAppendService([
      { id: 'n1', userId: CALLER, title: 'Research Papers - Q1', content: '' },
      { id: 'n2', userId: CALLER, title: 'Research Papers - Q2', content: '' },
    ]);

    await expect(
      service.appendContentByTitleHint(CALLER, 'research papers', 'x'),
    ).rejects.toThrow(/found more than one page/i);
    expect(prisma.updates).toHaveLength(0);
  });

  it("never matches another user's note even when it is the only candidate with that title", async () => {
    const { prisma, service } = buildAppendService([
      { id: 'n1', userId: OTHER, title: 'Research Papers', content: '' },
    ]);

    await expect(
      service.appendContentByTitleHint(CALLER, 'research papers', 'x'),
    ).rejects.toThrow(/couldn't find a page/i);
    expect(prisma.updates).toHaveLength(0);
  });

  // Regression cover for an unbounded-growth gap: nothing capped a note's
  // total length, so repeated appends (trivially reachable at volume via
  // Coach APPEND_NOTE_CONTENT) could grow a single row without limit.
  it('rejects and writes nothing when the append would exceed the length ceiling', async () => {
    const { prisma, service } = buildAppendService([
      { id: 'n1', userId: CALLER, title: 'Big Note', content: 'x'.repeat(65530) },
    ]);

    await expect(
      service.appendContentByTitleHint(CALLER, 'big note', 'this pushes it over'),
    ).rejects.toThrow(/65535-character limit/i);
    expect(prisma.updates).toHaveLength(0);
  });

  // The candidate query runs over EVERY note the user owns, so selecting
  // `content` there loaded every page's full body (up to 65535 chars each)
  // just to compare titles — and threw it all away on the ambiguous and
  // no-match paths. Only the winning row's body is ever needed.
  it('does not load note bodies while matching, only for the winning row', async () => {
    const { prisma, service } = buildAppendService([
      {
        id: 'n1',
        userId: CALLER,
        title: 'Research Papers',
        content: '<p>A</p>',
      },
      {
        id: 'n2',
        userId: CALLER,
        title: 'Groceries',
        content: 'x'.repeat(60000),
      },
    ]);

    const updated = await service.appendContentByTitleHint(
      CALLER,
      'research papers',
      'read about dynamo',
    );

    expect(prisma.findManySelects).toHaveLength(1);
    expect(prisma.findManySelects[0]).toEqual({ id: true, title: true });
    expect(prisma.findManySelects[0].content).toBeUndefined();
    // The winning row's body still made it into the append.
    expect((updated as any)?.content).toBe('<p>A</p><p>read about dynamo</p>');
  });

  it('writes nothing when the matched note disappears between match and read', async () => {
    const { prisma, service } = buildAppendService([
      {
        id: 'n1',
        userId: CALLER,
        title: 'Research Papers',
        content: '<p>A</p>',
      },
    ]);
    // Simulate the row being deleted after the candidate list was built.
    const originalFindFirst = prisma.note.findFirst;
    prisma.note.findFirst = async () => null;

    await expect(
      service.appendContentByTitleHint(CALLER, 'research papers', 'x'),
    ).rejects.toThrow(/couldn't find a page/i);
    expect(prisma.updates).toHaveLength(0);
    prisma.note.findFirst = originalFindFirst;
  });
});
