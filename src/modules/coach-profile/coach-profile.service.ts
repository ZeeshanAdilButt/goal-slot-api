import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { HabitsProfileDto } from './dto/habits-profile.dto';
import { UpsertHabitsProfileDto } from './dto/upsert-habits-profile.dto';

/**
 * Schema defaults mirror prisma/schema.prisma HabitsProfile defaults.
 * Returned (without persisting) when a user has never set their profile.
 */
const PROFILE_DEFAULTS = {
  why: '',
  phoneBlockerInstalled: false,
  distractingSubsCancelled: false,
  websiteBlockerUrls: '',
  sleepTargetHours: 8,
  bedtime: '23:00',
  wakeTime: '07:00',
  workEnvironment: '',
  additionalContext: '',
};

@Injectable()
export class CoachProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string): Promise<HabitsProfileDto> {
    const row = await this.prisma.habitsProfile.findUnique({
      where: { userId },
    });
    if (!row) {
      // Do not auto-create on read. Return the spec defaults so the client
      // can render a sensible blank form.
      return {
        userId,
        ...PROFILE_DEFAULTS,
        createdAt: null,
        updatedAt: null,
      };
    }
    return row as HabitsProfileDto;
  }

  async upsertProfile(
    userId: string,
    dto: UpsertHabitsProfileDto,
  ): Promise<HabitsProfileDto> {
    // Only forward fields that were explicitly provided so undefined-on-update
    // does not overwrite stored values with nulls.
    const data: Prisma.HabitsProfileUncheckedUpdateInput = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined) (data as Record<string, unknown>)[k] = v;
    }

    const row = await this.prisma.habitsProfile.upsert({
      where: { userId },
      create: { ...(data as Prisma.HabitsProfileUncheckedCreateInput), userId },
      update: data,
    });
    return row as HabitsProfileDto;
  }
}
