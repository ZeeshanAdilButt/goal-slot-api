import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppendJournalContentDto } from './dto/append-content.dto';
import { ListJournalEntriesDto } from './dto/list-journal-entries.dto';
import { UpdateJournalContentDto } from './dto/update-content.dto';
import { UpdateJournalMoodDto } from './dto/update-mood.dto';
import { UpsertJournalEntryDto } from './dto/upsert-journal-entry.dto';

function todayLocalIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Ceiling on a whole entry's content. Same number as
 * UpdateJournalContentDto/UpsertJournalEntryDto's `@MaxLength`, and it has to
 * be enforced on appends too: an entry that crept past it one append at a time
 * would be a row the journal editor itself could no longer save back, since
 * the editor PUTs the full body through those DTOs.
 */
const MAX_ENTRY_CONTENT_LENGTH = 65535;

/**
 * Join a new paragraph onto whatever an entry already holds.
 *
 * Byte-for-byte the same rule the voice fast-path applies client-side
 * (`appendJournalParagraph` in goalslot-mobile's app/(app)/voice.tsx, reached
 * via the APPEND_JOURNAL voice intent), so a line dictated through the
 * microphone and a line added by an approved Coach proposal are
 * indistinguishable once they land in the entry. Journal content is plain
 * text, not HTML, so this is a blank-line join with no escaping — do not
 * "improve" it into an HTML paragraph wrap without changing the voice path in
 * the same commit, or the two writers will start producing different-looking
 * entries for the same day.
 */
export function appendJournalParagraph(
  existing: string,
  addition: string,
): string {
  const trimmed = addition.trim();
  if (trimmed.length === 0) return existing;
  if (existing.trim().length === 0) return trimmed;
  return `${existing}\n\n${trimmed}`;
}

@Injectable()
export class CoachJournalService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: ListJournalEntriesDto) {
    const to = query.to ?? todayLocalIsoDate();
    const from = query.from ?? daysAgoIsoDate(60);
    return this.prisma.journalEntry.findMany({
      where: { userId, date: { gte: from, lte: to } },
      orderBy: { date: 'desc' },
    });
  }

  async getOne(userId: string, date: string) {
    const row = await this.prisma.journalEntry.findUnique({
      where: { userId_date: { userId, date } },
    });
    return row ?? null;
  }

  async upsert(userId: string, dto: UpsertJournalEntryDto) {
    const { date, mood, energy, content } = dto;

    const create: Prisma.JournalEntryUncheckedCreateInput = { userId, date };
    if (mood !== undefined) create.mood = mood;
    if (energy !== undefined) create.energy = energy;
    if (content !== undefined) create.content = content;

    const update: Prisma.JournalEntryUncheckedUpdateInput = {};
    if (mood !== undefined) update.mood = mood;
    if (energy !== undefined) update.energy = energy;
    if (content !== undefined) update.content = content;

    return this.prisma.journalEntry.upsert({
      where: { userId_date: { userId, date } },
      create,
      update,
    });
  }

  async updateContent(
    userId: string,
    date: string,
    dto: UpdateJournalContentDto,
  ) {
    // Matches the frontend `use-journal-entries.ts` behavior: upsert (never 404)
    // so the editor can persist a fresh day on first keystroke.
    return this.prisma.journalEntry.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, content: dto.content },
      update: { content: dto.content },
    });
  }

  /**
   * ADD a paragraph to a day's entry, creating the day if it has none yet.
   *
   * APPEND, NOT REPLACE, and that is the whole point of this method existing
   * next to `updateContent`. A journal is additive and the user has very
   * likely already written something today; a Coach proposal that overwrote it
   * would destroy work with no undo, from a card the user clicked once. Every
   * other writer in the product already agrees on this — the voice fast-path
   * appends (see `appendJournalParagraph` above), and the Journal tab's editor
   * only ever replaces content the user is looking at while they type it.
   *
   * Ownership: `userId` comes from the caller's JWT and is half of the
   * `[userId, date]` composite unique, so both the read and the write below
   * address only this user's own row. There is no id in the payload to trust
   * and no way for a caller-supplied `date` to reach another account.
   *
   * Not transactional: the read-modify-write can in principle lose one of two
   * genuinely simultaneous appends to the same day. Accepted deliberately —
   * this is one person writing in their own journal at human speed, the voice
   * path has had exactly the same property since it shipped, and the
   * alternative (raw SQL string concatenation) would put the append rule in a
   * second place where it could drift from the voice one.
   */
  async appendContent(userId: string, dto: AppendJournalContentDto) {
    const date = dto.date ?? todayLocalIsoDate();
    const addition = dto.content.trim();
    if (addition.length === 0) {
      throw new BadRequestException(
        'Journal content cannot be empty or whitespace only',
      );
    }

    const existing = await this.getOne(userId, date);
    const content = appendJournalParagraph(existing?.content ?? '', addition);
    if (content.length > MAX_ENTRY_CONTENT_LENGTH) {
      throw new BadRequestException(
        `Adding this would push your ${date} journal entry past the ${MAX_ENTRY_CONTENT_LENGTH}-character limit. Trim that day's entry first.`,
      );
    }

    return this.prisma.journalEntry.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, content },
      update: { content },
    });
  }

  async updateMood(userId: string, date: string, dto: UpdateJournalMoodDto) {
    return this.prisma.journalEntry.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, mood: dto.mood, energy: dto.energy },
      update: { mood: dto.mood, energy: dto.energy },
    });
  }

  async delete(userId: string, date: string): Promise<{ success: true }> {
    // deleteMany is idempotent — never throws on missing row.
    await this.prisma.journalEntry.deleteMany({ where: { userId, date } });
    return { success: true };
  }
}
