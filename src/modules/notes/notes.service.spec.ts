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
    findMany: async () => [],
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
});
