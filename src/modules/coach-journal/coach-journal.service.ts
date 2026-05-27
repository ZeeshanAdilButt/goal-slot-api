import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
