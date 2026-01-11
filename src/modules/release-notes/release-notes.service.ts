import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { CreateReleaseNoteDto } from './dto/create-release-note.dto'
import { UserRole } from '@prisma/client'

@Injectable()
export class ReleaseNotesService {
  constructor(private prisma: PrismaService) {}

  private ensureAdmin(role: UserRole) {
    if (role !== UserRole.ADMIN && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only admins can create release notes')
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
}
