import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { CreateNoteDto, UpdateNoteDto, ReorderNotesDto } from './dto/notes.dto';
import {
  appendNoteParagraph,
  matchNotesByTitle,
  stripDanglingNoteReference,
} from './note-content';

// Same ceiling coach-journal.service.ts enforces on journal entries. Notes
// content has no DB-level or DTO-level length limit, so without this a
// single note could be grown without bound — trivially reachable at volume
// via repeated Coach APPEND_NOTE_CONTENT actions targeting the same title.
// Exported because `create` deliberately does NOT enforce it (a create has no
// prior content to have grown past a ceiling) while `update` does — which
// means anything generating a note body elsewhere has to check the ceiling
// itself BEFORE creating the row, or it produces a note that saves once and
// then rejects every edit the editor's autosave ever makes, forever, with no
// visible cause. See note-summary.service.ts, which is exactly that case.
export const MAX_NOTE_CONTENT_LENGTH = 65535;

@Injectable()
export class NotesService {
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  async findAll(userId: string) {
    return this.prisma.note.findMany({
      where: { userId },
      orderBy: [{ parentId: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  // Owner-only fetch; throws if anyone else asks. Use findOneAccessible
  // when the caller might legitimately be a share recipient.
  async findOne(id: string, userId: string) {
    const note = await this.prisma.note.findUnique({
      where: { id },
    });

    if (!note) {
      throw new NotFoundException('Note not found');
    }

    if (note.userId !== userId) {
      throw new ForbiddenException('You do not have access to this note');
    }

    return note;
  }

  // Returns the note + a readOnly flag so the editor knows whether to
  // allow saves. Resolves owner OR active share recipient. Throws 404
  // if the user has neither relation (don't leak note existence).
  async findOneAccessible(id: string, userId: string) {
    const note = await this.prisma.note.findUnique({ where: { id } });
    if (!note) {
      throw new NotFoundException('Note not found');
    }
    if (note.userId === userId) {
      return { note, readOnly: false };
    }
    const share = await this.prisma.noteShare.findFirst({
      where: {
        noteId: id,
        recipientUserId: userId,
        revokedAt: null,
      },
    });
    if (!share) {
      throw new NotFoundException('Note not found');
    }
    if (!share.acceptedAt) {
      await this.prisma.noteShare.update({
        where: { id: share.id },
        data: { acceptedAt: new Date() },
      });
    }
    return { note, readOnly: true };
  }

  async create(userId: string, dto: CreateNoteDto) {
    if (dto.parentId) {
      // The parent note must also belong to the caller, otherwise a
      // client could attach a new note under a stranger's tree (or use
      // the 404-vs-403 split to probe whether a given note id exists).
      await this.findOne(dto.parentId, userId);
    }

    const maxOrder = await this.prisma.note.aggregate({
      where: {
        userId,
        parentId: dto.parentId || null,
      },
      _max: { order: true },
    });

    return this.prisma.note.create({
      data: {
        id: dto.id ?? undefined,
        title: dto.title,
        content: dto.content || '[]',
        icon: dto.icon,
        color: dto.color,
        parentId: dto.parentId || null,
        order: (maxOrder._max.order ?? -1) + 1,
        userId,
      },
    });
  }

  async update(id: string, userId: string, dto: UpdateNoteDto) {
    await this.findOne(id, userId);

    if (dto.parentId) {
      // The new parent must also belong to the caller — otherwise a
      // client could reparent its own note under (or probe the
      // existence of) another user's note by id.
      await this.findOne(dto.parentId, userId);

      const descendants = await this.getDescendantIds(id);
      if (descendants.includes(dto.parentId)) {
        throw new ForbiddenException(
          'Cannot move a note to its own descendant',
        );
      }
    }

    if (
      dto.content !== undefined &&
      dto.content.length > MAX_NOTE_CONTENT_LENGTH
    ) {
      throw new BadRequestException(
        `This note's content would exceed the ${MAX_NOTE_CONTENT_LENGTH}-character limit. Trim it and try again.`,
      );
    }

    return this.prisma.note.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.content !== undefined && { content: dto.content }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.parentId !== undefined && { parentId: dto.parentId }),
        ...(dto.order !== undefined && { order: dto.order }),
        ...(dto.isExpanded !== undefined && { isExpanded: dto.isExpanded }),
        ...(dto.isFavorite !== undefined && { isFavorite: dto.isFavorite }),
      },
    });
  }

  async delete(id: string, userId: string) {
    await this.findOne(id, userId);

    return this.prisma.note.delete({
      where: { id },
    });
  }

  /**
   * Find one of the caller's own notes by title hint and append a paragraph
   * to it. The one write path with no `id` at all — see AppendNoteContentDto
   * for why (the Coach is given note TITLES in its chat context, never ids,
   * so a title hint is the only thing it can echo back).
   *
   * Ownership is implicit rather than a separate check: `matchNotesByTitle`
   * only ever sees notes already scoped to `userId` by the `findMany` below,
   * so there is no id from a payload to trust and no way this can reach
   * another account's note.
   *
   * Read in two steps on purpose. Matching needs only id+title, so the
   * candidate query selects only those; `content` is then fetched for the ONE
   * row that won. Selecting `content` for every note the user owns just to
   * append to one of them meant a single append could pull megabytes into
   * memory (MAX_NOTE_CONTENT_LENGTH is 65535 per row, uncapped row count) and
   * threw all of it away on the ambiguous and no-match paths, which are the
   * common ones when the hint is wrong. Same class of fix as "Fix N+1 queries
   * and an unbounded findMany" (8d76362).
   *
   * Throws BadRequestException (not silently falling through to "no match")
   * when the hint is ambiguous or matches nothing, so the Coach proposal
   * action fails loudly with an explanation instead of guessing which page
   * was meant or creating an unwanted new one — see CoachProposalsService's
   * APPEND_NOTE_CONTENT case for how that surfaces to the user.
   *
   * Not transactional: the read-modify-write can in principle lose one of
   * two genuinely simultaneous appends to the same note. Accepted
   * deliberately, same as CoachJournalService.appendContent — this is one
   * person's own note, appended to at human speed.
   */
  async appendContentByTitleHint(
    userId: string,
    titleHint: string,
    addition: string,
  ) {
    const candidates = await this.prisma.note.findMany({
      where: { userId },
      select: { id: true, title: true },
    });

    const match = matchNotesByTitle(candidates, titleHint);

    if (match.status === 'ambiguous') {
      const names = match.candidates
        .slice(0, 5)
        .map((n) => `"${n.title}"`)
        .join(', ');
      throw new BadRequestException(
        `Found more than one page that could match "${titleHint}": ${names}. ` +
          'Nothing was added — ask again naming the page more specifically, ' +
          'or give it a more distinct title.',
      );
    }
    if (match.status === 'no-match') {
      throw new BadRequestException(
        `Couldn't find a page titled "${titleHint}" to add to. Check your ` +
          'Notes and try again with the exact (or closer) title, or create ' +
          'the page first.',
      );
    }

    // Only now, for the single winning row, is the body worth reading.
    // Re-scoped to `userId` rather than looked up by id alone: the id came
    // from the candidate list so it is already the caller's, but keeping the
    // owner in the predicate means this stays safe if the matching step is
    // ever changed to draw candidates from a wider set.
    const target = await this.prisma.note.findFirst({
      where: { id: match.note.id, userId },
      select: { content: true },
    });
    if (!target) {
      throw new BadRequestException(
        `Couldn't find a page titled "${titleHint}" to add to. Check your ` +
          'Notes and try again with the exact (or closer) title, or create ' +
          'the page first.',
      );
    }

    // Defensive normalization for the Coach's content/titleHint boundary:
    // when the model's split lands wrong on an ambiguous, comma-spliced
    // sentence, the tail left stuck to `addition` is a dangling "to my" /
    // "for my notes" style fragment reaching for the target page it failed
    // to fully separate out (see note-content.ts's stripDanglingNoteReference
    // doc comment). Falls back to the untouched `addition` if stripping
    // would leave nothing, so a pathological all-boilerplate string is never
    // turned into an empty paragraph.
    const sanitizedAddition = stripDanglingNoteReference(addition) || addition;

    const content = appendNoteParagraph(target.content, sanitizedAddition);
    if (content.length > MAX_NOTE_CONTENT_LENGTH) {
      throw new BadRequestException(
        `Adding this would push "${match.note.title}" past the ${MAX_NOTE_CONTENT_LENGTH}-character limit. Trim that page first.`,
      );
    }

    return this.prisma.note.update({
      where: { id: match.note.id },
      data: { content },
    });
  }

  async reorder(userId: string, items: ReorderNotesDto[]) {
    // Every target parentId must also belong to the caller — the
    // updateMany below already scopes the moved note itself by
    // (id, userId), but without this a client could drag a note of
    // its own under another user's note id.
    const parentIds = Array.from(
      new Set(
        items
          .map((item) => item.parentId)
          .filter((parentId): parentId is string => !!parentId),
      ),
    );
    // Was one findOne (one findUnique query) per unique parentId, sequentially
    // awaited - a drag that touches N distinct parents did N round trips
    // before a single row of the actual reorder even ran. Batched into one
    // findMany, then the same not-found/forbidden checks findOne did.
    if (parentIds.length > 0) {
      const parents = await this.prisma.note.findMany({
        where: { id: { in: parentIds } },
      });
      const parentsById = new Map(parents.map((p) => [p.id, p]));
      for (const parentId of parentIds) {
        const parent = parentsById.get(parentId);
        if (!parent) {
          throw new NotFoundException('Note not found');
        }
        if (parent.userId !== userId) {
          throw new ForbiddenException('You do not have access to this note');
        }
      }
    }

    const updates = items.map((item) =>
      this.prisma.note.updateMany({
        where: {
          id: item.noteId,
          userId,
        },
        data: {
          parentId: item.parentId,
          order: item.order,
        },
      }),
    );

    await this.prisma.$transaction(updates);
    return { success: true };
  }

  // Walks the note tree level by level, one query per depth level instead of
  // one query per node - the previous version recursed node-by-node, so
  // reparenting a note under a tree N notes deep did N sequential queries
  // just to check for a cycle. Same result set, same order-of-magnitude
  // input (a personal notes tree), far fewer round trips for anything with
  // more than a couple of children per level.
  private async getDescendantIds(noteId: string): Promise<string[]> {
    const ids: string[] = [];
    let frontier: string[] = [noteId];

    while (frontier.length > 0) {
      const children = await this.prisma.note.findMany({
        where: { parentId: { in: frontier } },
        select: { id: true },
      });
      if (children.length === 0) break;
      const childIds = children.map((c: { id: string }) => c.id);
      ids.push(...childIds);
      frontier = childIds;
    }

    return ids;
  }

  // ============================================================
  // Sharing
  // ============================================================

  // Presence of publicShareToken means link sharing is on. The token is
  // opaque and rotated by toggling off then back on.
  async enablePublicLink(noteId: string, userId: string) {
    await this.findOne(noteId, userId);
    const existing = await this.prisma.note.findUnique({
      where: { id: noteId },
      select: { publicShareToken: true },
    });
    const token = existing?.publicShareToken ?? this.generateToken();
    if (!existing?.publicShareToken) {
      await this.prisma.note.update({
        where: { id: noteId },
        data: { publicShareToken: token },
      });
    }
    return { token };
  }

  async revokePublicLink(noteId: string, userId: string) {
    await this.findOne(noteId, userId);
    await this.prisma.note.update({
      where: { id: noteId },
      data: { publicShareToken: null },
    });
    return { success: true };
  }

  async getShareState(noteId: string, userId: string) {
    await this.findOne(noteId, userId);
    const [note, shares] = await Promise.all([
      this.prisma.note.findUnique({
        where: { id: noteId },
        select: { publicShareToken: true },
      }),
      this.prisma.noteShare.findMany({
        where: { noteId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          recipientEmail: true,
          recipientUserId: true,
          permission: true,
          acceptedAt: true,
          createdAt: true,
          recipientUser: {
            select: { id: true, name: true, email: true, avatar: true },
          },
        },
      }),
    ]);
    return {
      publicShareToken: note?.publicShareToken ?? null,
      shares,
    };
  }

  async invite(noteId: string, ownerId: string, rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    await this.findOne(noteId, ownerId);

    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { email: true, name: true },
    });
    if (!owner) {
      throw new NotFoundException('Owner not found');
    }
    if (owner.email.toLowerCase() === email) {
      throw new BadRequestException('You cannot share a note with yourself');
    }

    const recipientUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    const share = await this.prisma.noteShare.upsert({
      where: {
        noteId_recipientEmail: { noteId, recipientEmail: email },
      },
      update: {
        revokedAt: null,
        recipientUserId: recipientUser?.id ?? null,
      },
      create: {
        noteId,
        ownerId,
        recipientEmail: email,
        recipientUserId: recipientUser?.id ?? null,
      },
    });

    // Best-effort email. If Resend is misconfigured we still want the
    // share record to exist so the recipient can find it in-app.
    try {
      const note = await this.prisma.note.findUnique({
        where: { id: noteId },
        select: { title: true },
      });
      await this.emailService.sendNoteShareInvitation({
        toEmail: email,
        inviterName: owner.name,
        inviterEmail: owner.email,
        noteTitle: note?.title || 'Untitled',
        noteId,
        isExistingUser: !!recipientUser,
      });
    } catch {
      // swallow: share record still works in-app
    }

    return share;
  }

  async revokeInvite(noteId: string, ownerId: string, shareId: string) {
    await this.findOne(noteId, ownerId);
    const share = await this.prisma.noteShare.findUnique({
      where: { id: shareId },
    });
    if (!share || share.noteId !== noteId) {
      throw new NotFoundException('Share not found');
    }
    await this.prisma.noteShare.update({
      where: { id: shareId },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  // Lazy-resolves invites sent to this user's email before they had an
  // account, then returns all active shares for them.
  async findSharedWithMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const email = user.email.toLowerCase();
    await this.prisma.noteShare.updateMany({
      where: {
        recipientEmail: email,
        recipientUserId: null,
        revokedAt: null,
      },
      data: { recipientUserId: userId },
    });
    const shares = await this.prisma.noteShare.findMany({
      where: { recipientUserId: userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        note: {
          select: {
            id: true,
            title: true,
            icon: true,
            color: true,
            updatedAt: true,
          },
        },
        owner: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    });
    return shares.map((s) => ({
      shareId: s.id,
      note: s.note,
      owner: s.owner,
      acceptedAt: s.acceptedAt,
      createdAt: s.createdAt,
      permission: s.permission,
    }));
  }

  async findByPublicToken(token: string) {
    if (!token || token.length < 16) {
      throw new NotFoundException('Note not found');
    }
    const note = await this.prisma.note.findUnique({
      where: { publicShareToken: token },
      select: {
        id: true,
        title: true,
        content: true,
        icon: true,
        color: true,
        updatedAt: true,
        user: { select: { name: true } },
      },
    });
    if (!note) {
      throw new NotFoundException('Note not found');
    }
    return note;
  }

  private generateToken(): string {
    return randomBytes(24).toString('base64url');
  }
}
