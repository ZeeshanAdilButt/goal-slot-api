import { WhiteboardsService } from './whiteboards.service';

// Cost cover for WhiteboardsService.findAll.
//
// The list endpoint returned full rows. `Whiteboard.content` is a Json column
// holding an Excalidraw scene, hard-capped at 2 MB per row by `update`, so a
// 20-board account fetched megabytes of scene data to draw a sidebar. Beyond
// the bandwidth, Postgres detoasts every row, the pg driver JSON.parses it and
// Nest JSON.stringifies it back — both on Node's single thread, blocking every
// other request behind it.
//
// The fake below HONOURS `select` rather than merely recording it. Asserting
// on `args.select` alone would pass against a stub that ignored it, which
// would not be a real test — the point is that the caller receives no scene.

const OWNER = 'owner-user-id';

/** Stand-in for a board carrying a pasted screenshot. */
const FAT_CONTENT = {
  elements: new Array(5000).fill({ type: 'rectangle', x: 1, y: 1 }),
  files: { 'file-1': { dataURL: 'data:image/png;base64,' + 'A'.repeat(1024) } },
};

const FULL_ROW = {
  id: 'wb1',
  title: 'Q3 planning',
  icon: null,
  color: null,
  isFavorite: false,
  userId: OWNER,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  publicShareToken: 'secret-share-token',
  deletedAt: null,
  deletedReason: null,
  deletedByUserId: null,
  content: FAT_CONTENT,
};

class FakePrisma {
  findManyArgs: any[] = [];

  whiteboard = {
    findMany: async (args: any) => {
      this.findManyArgs.push(args);
      if (!args?.select) return [{ ...FULL_ROW }];
      return [
        Object.fromEntries(
          Object.entries(FULL_ROW).filter(([key]) => args.select[key]),
        ),
      ];
    },
  };
}

function buildService() {
  const prisma = new FakePrisma();
  const service = new WhiteboardsService(prisma as any, {} as any);
  return { prisma, service };
}

describe('WhiteboardsService.findAll payload', () => {
  it('does not return scene content', async () => {
    const { service } = buildService();

    const rows: any[] = await service.findAll(OWNER);

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('content');
  });

  it('does not leak the public share token on a list row', async () => {
    const { service } = buildService();

    const rows: any[] = await service.findAll(OWNER);

    expect(rows[0]).not.toHaveProperty('publicShareToken');
  });

  it('still returns everything the sidebar and header render', async () => {
    const { service } = buildService();

    const [row]: any[] = await service.findAll(OWNER);

    // The web header reads title/icon/colour off the list row so it does not
    // flash while the detail query resolves. Dropping any of these regresses
    // that, so pin the whole shape.
    expect(row).toEqual({
      id: 'wb1',
      title: 'Q3 planning',
      icon: null,
      color: null,
      isFavorite: false,
      userId: OWNER,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });
  });

  it('still scopes to the caller and excludes soft-deleted boards', async () => {
    const { prisma, service } = buildService();

    await service.findAll(OWNER);

    expect(prisma.findManyArgs[0].where).toEqual({
      userId: OWNER,
      deletedAt: null,
    });
  });

  it('keeps the newest-first ordering', async () => {
    const { prisma, service } = buildService();

    await service.findAll(OWNER);

    expect(prisma.findManyArgs[0].orderBy).toEqual([{ createdAt: 'desc' }]);
  });
});
