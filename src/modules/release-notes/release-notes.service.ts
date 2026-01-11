import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { CreateReleaseNoteDto } from './dto/create-release-note.dto'
import { UpdateReleaseNoteDto } from './dto/update-release-note.dto'
import { UserRole } from '@prisma/client'

@Injectable()
export class ReleaseNotesService {
  constructor(private prisma: PrismaService) {}

  private ensureAdmin(role: UserRole) {
    if (role !== UserRole.ADMIN && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Admin access required')
    }
  }

  async create(dto: CreateReleaseNoteDto, role: UserRole) {
    this.ensureAdmin(role)
    return this.prisma.releaseNote.create({
      data: {
        version: dto.version,
        title: dto.title,
        content: dto.content,
        publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : undefined,
      },
    })
  }

  async update(id: string, dto: UpdateReleaseNoteDto, role: UserRole) {
    this.ensureAdmin(role)
    const note = await this.prisma.releaseNote.findUnique({ where: { id } })
    if (!note) {
      throw new NotFoundException('Release note not found')
    }

    // If resetSeen is true, delete all seen records for this note
    if (dto.resetSeen) {
      await this.prisma.releaseNoteSeen.deleteMany({
        where: { noteId: id },
      })
    }

    const { resetSeen, ...updateData } = dto

    return this.prisma.releaseNote.update({
      where: { id },
      data: {
        ...updateData,
        publishedAt: updateData.publishedAt ? new Date(updateData.publishedAt) : undefined,
        // If we reset seen status, we might want to update the updatedAt or publishedAt to bump it? 
        // Or essentially it just reappears in "unseen" list because it's no longer in "seen" list.
      },
    })
  }

  async findAll() {
    return this.prisma.releaseNote.findMany({
      orderBy: { publishedAt: 'desc' },
    })
  }

  async delete(id: string, role: UserRole) {
    this.ensureAdmin(role)
    const note = await this.prisma.releaseNote.findUnique({ where: { id } })
    if (!note) {
      throw new NotFoundException('Release note not found')
    }
    return this.prisma.releaseNote.delete({ where: { id } })
  }

  async latest(userId: string) {
    const note = await this.prisma.releaseNote.findFirst({
      orderBy: { publishedAt: 'desc' },
    })

    if (!note) return { note: null, seen: true }

    const seen = await this.prisma.releaseNoteSeen.findUnique({
      where: { noteId_userId: { noteId: note.id, userId } },
    })

    return { note, seen: Boolean(seen) }
  }

  async markSeen(noteId: string, userId: string) {
    const note = await this.prisma.releaseNote.findUnique({ where: { id: noteId } })
    if (!note) {
      throw new NotFoundException('Release note not found')
    }

    await this.prisma.releaseNoteSeen.upsert({
      where: { noteId_userId: { noteId, userId } },
      update: { seenAt: new Date() },
      create: { noteId, userId },
    })

    return { noteId, seen: true }
  }

  async findUnseen(userId: string) {
    return this.prisma.releaseNote.findMany({
      where: {
        seenBy: {
          none: {
            userId: userId,
          },
        },
      },
      orderBy: { publishedAt: 'desc' },
    })
  }
}
