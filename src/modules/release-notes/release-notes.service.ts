import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReleaseNoteDto } from './dto/create-release-note.dto';
import { UpdateReleaseNoteDto } from './dto/update-release-note.dto';
import { NotificationType, UserRole } from '@prisma/client';
import { ReminderDispatchService } from '../reminders/reminder-dispatch.service';

@Injectable()
export class ReleaseNotesService {
  private readonly logger = new Logger(ReleaseNotesService.name);

  constructor(
    private prisma: PrismaService,
    private readonly reminderDispatch: ReminderDispatchService,
  ) {}

  private ensureAdmin(role: UserRole) {
    if (role !== UserRole.ADMIN && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Admin access required');
    }
  }

  async create(dto: CreateReleaseNoteDto, role: UserRole) {
    this.ensureAdmin(role);
    const note = await this.prisma.releaseNote.create({
      data: {
        version: dto.version,
        title: dto.title,
        content: dto.content,
        publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : undefined,
      },
    });

    // Best-effort, same pattern InstructionsService.assign already uses:
    // the release note itself has already committed above, so a
    // notification failure (for one user or all of them) must never make
    // this call look like it failed. goalslot-mobile's deep-link resolver
    // already speculatively handles `{ type: 'release' }` — no `url` here
    // by design, so a tap triggers the in-app OTA check/apply flow rather
    // than sending anyone to a page for a JS-only update.
    void this.notifyAllUsersOfRelease(note.version, note.title).catch(
      (err) =>
        this.logger.error(
          `Failed to fan out APP_RELEASE notification for ${note.version}`,
          err,
        ),
    );

    return note;
  }

  private async notifyAllUsersOfRelease(
    version: string,
    title: string,
  ): Promise<void> {
    const users = await this.prisma.user.findMany({ select: { id: true } });
    const results = await Promise.allSettled(
      users.map((user) =>
        this.reminderDispatch.dispatchToUser(user.id, {
          title: `GoalSlot ${version}`,
          body: title,
          data: { type: 'release' },
          notificationType: NotificationType.APP_RELEASE,
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        `APP_RELEASE fan-out for ${version}: ${failed}/${users.length} users failed`,
      );
    }
  }

  async update(id: string, dto: UpdateReleaseNoteDto, role: UserRole) {
    this.ensureAdmin(role);
    const note = await this.prisma.releaseNote.findUnique({ where: { id } });
    if (!note) {
      throw new NotFoundException('Release note not found');
    }

    // If resetSeen is true, delete all seen records for this note
    if (dto.resetSeen) {
      await this.prisma.releaseNoteSeen.deleteMany({
        where: { noteId: id },
      });
    }

    const { resetSeen, ...updateData } = dto;

    return this.prisma.releaseNote.update({
      where: { id },
      data: {
        ...updateData,
        publishedAt: updateData.publishedAt
          ? new Date(updateData.publishedAt)
          : undefined,
        // If we reset seen status, we might want to update the updatedAt or publishedAt to bump it?
        // Or essentially it just reappears in "unseen" list because it's no longer in "seen" list.
      },
    });
  }

  async findAll() {
    return this.prisma.releaseNote.findMany({
      orderBy: { publishedAt: 'desc' },
    });
  }

  async delete(id: string, role: UserRole) {
    this.ensureAdmin(role);
    const note = await this.prisma.releaseNote.findUnique({ where: { id } });
    if (!note) {
      throw new NotFoundException('Release note not found');
    }
    return this.prisma.releaseNote.delete({ where: { id } });
  }

  async latest(userId: string) {
    const note = await this.prisma.releaseNote.findFirst({
      orderBy: { publishedAt: 'desc' },
    });

    if (!note) return { note: null, seen: true };

    const seen = await this.prisma.releaseNoteSeen.findUnique({
      where: { noteId_userId: { noteId: note.id, userId } },
    });

    return { note, seen: Boolean(seen) };
  }

  async markSeen(noteId: string, userId: string) {
    const note = await this.prisma.releaseNote.findUnique({
      where: { id: noteId },
    });
    if (!note) {
      throw new NotFoundException('Release note not found');
    }

    await this.prisma.releaseNoteSeen.upsert({
      where: { noteId_userId: { noteId, userId } },
      update: { seenAt: new Date() },
      create: { noteId, userId },
    });

    return { noteId, seen: true };
  }

  async findUnseen(userId: string) {
    // Hard-cap to the 4 most recent unseen notes so a brand-new user who
    // joins after we have shipped a long history of releases does not get
    // a backlog of 20 "Got it" prompts to clear. Older unseen notes just
    // stay marked-unseen in the DB; they are simply not surfaced.
    return this.prisma.releaseNote.findMany({
      where: {
        seenBy: {
          none: {
            userId: userId,
          },
        },
      },
      orderBy: { publishedAt: 'desc' },
      take: 4,
    });
  }
}
