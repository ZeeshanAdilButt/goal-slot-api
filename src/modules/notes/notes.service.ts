import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateNoteDto, UpdateNoteDto, ReorderNotesDto } from './dto/notes.dto';

@Injectable()
export class NotesService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.note.findMany({
      where: { userId },
      orderBy: [{ parentId: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
    });
  }

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

  async create(userId: string, dto: CreateNoteDto) {
    // Get the highest order for the parent
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
    // Verify ownership
    await this.findOne(id, userId);

    // Prevent moving note to its own descendant
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
    // Verify ownership
    await this.findOne(id, userId);

    // Delete the note (children will be deleted by cascade)
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
}
