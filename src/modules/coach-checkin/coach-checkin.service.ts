import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListCheckinsDto } from './dto/list-checkins.dto';
import { UpsertDailyCheckinDto } from './dto/upsert-daily-checkin.dto';

function todayLocalIsoDate(): string {
  // NOTE: server-local "today" — v2 should accept a client tz hint and compute
  // the day boundary there.
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class CoachCheckinService {
  constructor(private readonly prisma: PrismaService) {}

  async listCheckins(userId: string, query: ListCheckinsDto) {
    const to = query.to ?? todayLocalIsoDate();
    const from = query.from ?? daysAgoIsoDate(30);
    return this.prisma.dailyCheckin.findMany({
      where: { userId, date: { gte: from, lte: to } },
      orderBy: { date: 'desc' },
    });
  }

  async getToday(userId: string) {
    // Server-local "today" — see note in todayLocalIsoDate.
    const date = todayLocalIsoDate();
    const row = await this.prisma.dailyCheckin.findUnique({
      where: { userId_date: { userId, date } },
    });
    return row ?? null;
  }

  async upsertCheckin(userId: string, dto: UpsertDailyCheckinDto) {
    const { date, mood, energy, focus, blocked, worked } = dto;
    const create: Prisma.DailyCheckinUncheckedCreateInput = {
      userId,
      date,
      mood,
      energy,
      focus,
    };
    if (blocked !== undefined) create.blocked = blocked;
    if (worked !== undefined) create.worked = worked;

    const update: Prisma.DailyCheckinUncheckedUpdateInput = {
      mood,
      energy,
      focus,
    };
    if (blocked !== undefined) update.blocked = blocked;
    if (worked !== undefined) update.worked = worked;

    return this.prisma.dailyCheckin.upsert({
      where: { userId_date: { userId, date } },
      create,
      update,
    });
  }
}
