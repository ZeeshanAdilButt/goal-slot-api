import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';

/**
 * Cover for the notifications work behind three user-reported items:
 *   1. a bulk "mark all read"
 *   3. message notifications leaving the bell (the `scope` param)
 *   + the FEEDBACK_REPLY payload's missing `type` discriminant.
 *
 * The fake below is not a spy that records arguments — it actually
 * evaluates the `where` predicate against an in-memory row set. That is
 * deliberate: this codebase has shipped real IDOR bugs, and asserting
 * "the query object contained a userId key" would pass just as happily if
 * the value were wrong or the term were ORed rather than ANDed. Evaluating
 * it means the cross-user tests below fail if the scoping is actually
 * broken, not merely if it is spelled differently.
 */

interface Row {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}

let seq = 0;

function row(overrides: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `n_${seq}`,
    userId: 'user_a',
    type: NotificationType.INSTRUCTION_ASSIGNED,
    title: `notification ${seq}`,
    body: null,
    data: {},
    readAt: null,
    // Descending id order == descending createdAt order, so `orderBy
    // createdAt desc` and the cursor walk are deterministic.
    createdAt: new Date(2026, 0, 1, 0, 0, seq),
    ...overrides,
  };
}

class FakePrisma {
  rows: Row[] = [];
  updateManyCalls: any[] = [];
  findManyCalls: any[] = [];
  countCalls: any[] = [];

  notification = {
    findMany: async (args: any) => {
      this.findManyCalls.push(args);
      let matched = this.rows
        .filter((r) => matches(r, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      if (args.cursor) {
        const index = matched.findIndex((r) => r.id === args.cursor.id);
        if (index === -1) {
          // Prisma throws when the cursor row is not in the filtered set.
          // Mirroring that keeps the "don't mix scopes across pages"
          // hazard visible rather than silently papered over.
          throw new Error(`cursor ${args.cursor.id} not found in result set`);
        }
        matched = matched.slice(index + (args.skip ?? 0));
      }

      return args.take ? matched.slice(0, args.take) : matched;
    },

    count: async (args: any) => {
      this.countCalls.push(args);
      return this.rows.filter((r) => matches(r, args.where)).length;
    },

    updateMany: async (args: any) => {
      this.updateManyCalls.push(args);
      const matched = this.rows.filter((r) => matches(r, args.where));
      matched.forEach((r) => Object.assign(r, args.data));
      return { count: matched.length };
    },

    findUnique: async (args: any) =>
      this.rows.find((r) => r.id === args.where.id) ?? null,

    update: async (args: any) => {
      const target = this.rows.find((r) => r.id === args.where.id)!;
      Object.assign(target, args.data);
      return target;
    },

    create: async (args: any) => {
      const created = row(args.data);
      this.rows.push(created);
      return created;
    },
  };
}

/** Evaluates the subset of Prisma `where` syntax these queries use. */
function matches(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.userId !== undefined && r.userId !== where.userId) return false;
  if (where.readAt !== undefined) {
    if (where.readAt === null && r.readAt !== null) return false;
  }
  if (where.type?.notIn && where.type.notIn.includes(r.type)) return false;
  return true;
}

function build() {
  const prisma = new FakePrisma();
  const service = new NotificationsService(prisma as any);
  return { prisma, service };
}

beforeEach(() => {
  seq = 0;
});

// ---------- markAllRead: bulk, and scoped to the caller ----------

describe('NotificationsService.markAllRead', () => {
  it('clears the caller’s unread rows in a single updateMany, never a loop', async () => {
    const { prisma, service } = build();
    prisma.rows = [row(), row(), row(), row()];

    const result = await service.markAllRead('user_a');

    // The cost constraint made concrete: four unread rows, one statement.
    expect(prisma.updateManyCalls).toHaveLength(1);
    expect(prisma.updateManyCalls[0].where).toMatchObject({
      userId: 'user_a',
      readAt: null,
    });
    expect(result.updated).toBe(4);
    expect(prisma.rows.every((r) => r.readAt !== null)).toBe(true);
  });

  it('CANNOT touch another user’s notifications (IDOR guard)', async () => {
    const { prisma, service } = build();
    const mine = [row({ userId: 'user_a' }), row({ userId: 'user_a' })];
    const theirs = [
      row({ userId: 'user_b' }),
      row({ userId: 'user_b' }),
      row({ userId: 'user_b' }),
    ];
    prisma.rows = [...mine, ...theirs];

    const result = await service.markAllRead('user_a');

    expect(result.updated).toBe(2);
    expect(mine.every((r) => r.readAt !== null)).toBe(true);
    // The whole point: user_b's rows are still unread afterwards.
    expect(theirs.every((r) => r.readAt === null)).toBe(true);
  });

  it('marks nothing at all when the caller owns no notifications', async () => {
    const { prisma, service } = build();
    prisma.rows = [row({ userId: 'user_b' }), row({ userId: 'user_b' })];

    const result = await service.markAllRead('user_a');

    expect(result.updated).toBe(0);
    expect(prisma.rows.every((r) => r.readAt === null)).toBe(true);
  });

  it('leaves already-read rows alone rather than restamping them', async () => {
    const { prisma, service } = build();
    const readAt = new Date(2020, 0, 1);
    const alreadyRead = row({ readAt });
    prisma.rows = [alreadyRead, row()];

    const result = await service.markAllRead('user_a');

    expect(result.updated).toBe(1);
    expect(alreadyRead.readAt).toBe(readAt);
  });

  it('under scope=general does not clear MESSAGE_RECEIVED rows the bell never showed', async () => {
    const { prisma, service } = build();
    const message = row({ type: NotificationType.MESSAGE_RECEIVED });
    const general = row({ type: NotificationType.INSTRUCTION_ASSIGNED });
    prisma.rows = [message, general];

    const result = await service.markAllRead('user_a', 'general');

    expect(result.updated).toBe(1);
    expect(general.readAt).not.toBeNull();
    // Marking the bell read must not silently destroy state that lives on
    // the messages icon and was never visible in the bell.
    expect(message.readAt).toBeNull();
  });

  it('under scope=all clears message notifications too', async () => {
    const { prisma, service } = build();
    prisma.rows = [
      row({ type: NotificationType.MESSAGE_RECEIVED }),
      row({ type: NotificationType.INSTRUCTION_ASSIGNED }),
    ];

    const result = await service.markAllRead('user_a', 'all');

    expect(result.updated).toBe(2);
    expect(prisma.rows.every((r) => r.readAt !== null)).toBe(true);
  });

  it('reports the applied scope and a zero remaining unread count', async () => {
    const { prisma, service } = build();
    prisma.rows = [row()];

    expect(await service.markAllRead('user_a', 'general')).toEqual({
      updated: 1,
      scope: 'general',
      unreadCount: 0,
    });
  });

  it('defaults to scope=all when none is given, preserving caller-agnostic behavior', async () => {
    const { prisma, service } = build();
    prisma.rows = [row({ type: NotificationType.MESSAGE_RECEIVED })];

    const result = await service.markAllRead('user_a');

    expect(result.scope).toBe('all');
    expect(result.updated).toBe(1);
  });
});

// ---------- list: scope applies to items AND unreadCount ----------

describe('NotificationsService.list scoping', () => {
  it('excludes MESSAGE_RECEIVED from BOTH items and unreadCount under scope=general', async () => {
    const { prisma, service } = build();
    prisma.rows = [
      row({ type: NotificationType.MESSAGE_RECEIVED }),
      row({ type: NotificationType.MESSAGE_RECEIVED }),
      row({ type: NotificationType.INSTRUCTION_ASSIGNED }),
    ];

    const result = await service.list({ userId: 'user_a', scope: 'general' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].type).toBe(NotificationType.INSTRUCTION_ASSIGNED);
    // The trap: if this were 3, the bell would show a badge over a list
    // with nothing unread in it, and no action could ever clear it.
    expect(result.unreadCount).toBe(1);
    expect(result.scope).toBe('general');
  });

  it('applies the identical type predicate to the findMany and the count', async () => {
    const { prisma, service } = build();
    prisma.rows = [row()];

    await service.list({ userId: 'user_a', scope: 'general' });

    expect(prisma.findManyCalls[0].where.type).toEqual({
      notIn: [NotificationType.MESSAGE_RECEIVED],
    });
    expect(prisma.countCalls[0].where.type).toEqual({
      notIn: [NotificationType.MESSAGE_RECEIVED],
    });
    expect(prisma.countCalls[0].where.readAt).toBeNull();
  });

  it('returns every type and counts every type when scope is omitted', async () => {
    const { prisma, service } = build();
    prisma.rows = [
      row({ type: NotificationType.MESSAGE_RECEIVED }),
      row({ type: NotificationType.INSTRUCTION_ASSIGNED }),
    ];

    const result = await service.list({ userId: 'user_a' });

    expect(result.items).toHaveLength(2);
    expect(result.unreadCount).toBe(2);
    expect(result.scope).toBe('all');
    expect(prisma.findManyCalls[0].where.type).toBeUndefined();
    expect(prisma.countCalls[0].where.type).toBeUndefined();
  });

  it('never lists or counts another user’s notifications', async () => {
    const { prisma, service } = build();
    prisma.rows = [
      row({ userId: 'user_b' }),
      row({ userId: 'user_b' }),
      row({ userId: 'user_a' }),
    ];

    const result = await service.list({ userId: 'user_a' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].userId).toBe('user_a');
    expect(result.unreadCount).toBe(1);
  });

  it('paginates within the filtered set, so a scoped page is never short', async () => {
    const { prisma, service } = build();
    // Interleaved so a client-side filter would render ragged pages.
    prisma.rows = [
      row({ type: NotificationType.INSTRUCTION_ASSIGNED }),
      row({ type: NotificationType.MESSAGE_RECEIVED }),
      row({ type: NotificationType.INSTRUCTION_ASSIGNED }),
      row({ type: NotificationType.MESSAGE_RECEIVED }),
      row({ type: NotificationType.INSTRUCTION_ASSIGNED }),
    ];

    const first = await service.list({
      userId: 'user_a',
      scope: 'general',
      limit: 2,
    });

    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = await service.list({
      userId: 'user_a',
      scope: 'general',
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    // Three general rows across two pages, no overlap, no message rows.
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect(
      [...first.items, ...second.items].every(
        (i) => i.type !== NotificationType.MESSAGE_RECEIVED,
      ),
    ).toBe(true);
  });

  it('does not drop a row at the page boundary (nextCursor is the last returned row)', async () => {
    const { prisma, service } = build();
    prisma.rows = [row(), row(), row(), row()];

    const first = await service.list({ userId: 'user_a', limit: 2 });
    const second = await service.list({
      userId: 'user_a',
      limit: 2,
      cursor: first.nextCursor,
    });

    // nextCursor must be the last row we handed back, not the first one we
    // withheld — otherwise the next page's `skip: 1` steps over it.
    expect(first.nextCursor).toBe(first.items[first.items.length - 1].id);

    const seen = [...first.items, ...second.items].map((i) => i.id);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(second.hasMore).toBe(false);
  });

  it('clamps limit into the 1..50 range', async () => {
    const { prisma, service } = build();
    prisma.rows = [row()];

    await service.list({ userId: 'user_a', limit: 999 });
    expect(prisma.findManyCalls[0].take).toBe(51);

    await service.list({ userId: 'user_a', limit: 0 });
    expect(prisma.findManyCalls[1].take).toBe(2);
  });
});

// ---------- per-row markRead ownership (unchanged, locked down) ----------

describe('NotificationsService.markRead', () => {
  it('refuses to mark a notification belonging to someone else', async () => {
    const { prisma, service } = build();
    const theirs = row({ userId: 'user_b' });
    prisma.rows = [theirs];

    await expect(service.markRead(theirs.id, 'user_a')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(theirs.readAt).toBeNull();
  });
});

// ---------- FEEDBACK_REPLY payload discriminant ----------

describe('NotificationsService.createFeedbackReplyNotification', () => {
  it('writes a `type` discriminant so client tap resolvers can route it', async () => {
    const { service } = build();

    const created: any = await service.createFeedbackReplyNotification({
      userId: 'user_a',
      feedbackId: 'fb_1',
      responseId: 'resp_1',
      message: 'thanks for reporting this',
    });

    expect(created.data).toEqual({
      type: 'feedback',
      feedbackId: 'fb_1',
      responseId: 'resp_1',
    });
  });

  it('truncates the body preview to 140 characters', async () => {
    const { service } = build();

    const created: any = await service.createFeedbackReplyNotification({
      userId: 'user_a',
      feedbackId: 'fb_1',
      responseId: 'resp_1',
      message: 'x'.repeat(500),
    });

    expect(created.body).toHaveLength(140);
  });
});

// ---------- controller query parsing ----------

describe('NotificationsController query handling', () => {
  function buildController() {
    const prisma = new FakePrisma();
    const service = new NotificationsService(prisma as any);
    const controller = new NotificationsController(service);
    const req = { user: { sub: 'user_a' } } as AuthenticatedRequest;
    return { prisma, service, controller, req };
  }

  it('rejects a non-numeric limit with 400 instead of blowing up on take: NaN', async () => {
    const { controller, req } = buildController();

    await expect(
      controller.list(req, undefined, 'abc', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown scope with 400', async () => {
    const { controller, req } = buildController();

    await expect(
      controller.list(req, undefined, undefined, 'messages'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.markAllRead(req, 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('passes a valid scope through to the service on both routes', async () => {
    const { prisma, controller, req } = buildController();
    prisma.rows = [row({ type: NotificationType.MESSAGE_RECEIVED }), row()];

    const listed = await controller.list(req, undefined, '10', 'general');
    expect(listed.items).toHaveLength(1);
    expect(listed.unreadCount).toBe(1);

    const marked = await controller.markAllRead(req, 'general');
    expect(marked).toEqual({ updated: 1, scope: 'general', unreadCount: 0 });
  });

  it('treats an absent scope/limit as the historical defaults', async () => {
    const { prisma, controller, req } = buildController();
    prisma.rows = [row({ type: NotificationType.MESSAGE_RECEIVED }), row()];

    const listed = await controller.list(req, undefined, undefined, undefined);
    expect(listed.items).toHaveLength(2);
    expect(listed.unreadCount).toBe(2);
    expect(listed.scope).toBe('all');

    const marked = await controller.markAllRead(req, undefined);
    expect(marked.scope).toBe('all');
    expect(marked.updated).toBe(2);
  });
});
