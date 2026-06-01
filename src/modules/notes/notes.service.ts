import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { CreateNoteDto, UpdateNoteDto, ReorderNotesDto } from './dto/notes.dto';

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
    const maxOrder = await this.prisma.note.aggregate({
      where: {
        userId,
        parentId: dto.parentId || null,
      },
      _max: { order: true },
    });

    return this.prisma.note.create({
      data: {
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
      const descendants = await this.getDescendantIds(id);
      if (descendants.includes(dto.parentId)) {
        throw new ForbiddenException('Cannot move a note to its own descendant');
      }
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

  async reorder(userId: string, items: ReorderNotesDto[]) {
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

  private async getDescendantIds(noteId: string): Promise<string[]> {
    const children = await this.prisma.note.findMany({
      where: { parentId: noteId },
      select: { id: true },
    });

    const ids: string[] = children.map((c: { id: string }) => c.id);

    for (const child of children) {
      const childDescendants = await this.getDescendantIds(child.id);
      ids.push(...childDescendants);
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
          select: { id: true, title: true, icon: true, color: true, updatedAt: true },
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
