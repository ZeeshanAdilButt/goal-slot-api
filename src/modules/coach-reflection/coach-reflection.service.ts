import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpsertGoalReflectionDto } from './dto/upsert-goal-reflection.dto';
import { isoWeekKey } from './iso-week';

@Injectable()
export class CoachReflectionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verify the goal exists AND belongs to this user. We use findFirst with
   * BOTH conditions so we never disclose existence of a goal owned by a
   * different user — leaking a 403-vs-404 distinction would let a caller
   * enumerate other users' goal ids.
   */
  private async assertGoalOwnership(
    userId: string,
    goalId: string,
  ): Promise<void> {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      select: { id: true },
    });
    if (!goal) {
      throw new NotFoundException('Goal not found');
    }
  }

  async getReflection(userId: string, goalId: string, weekKey?: string) {
    await this.assertGoalOwnership(userId, goalId);
    const key = weekKey ?? isoWeekKey();
    const row = await this.prisma.goalReflection.findUnique({
      where: { userId_goalId_weekKey: { userId, goalId, weekKey: key } },
    });
    return row ?? null;
  }

  async getHistory(userId: string, goalId: string) {
    await this.assertGoalOwnership(userId, goalId);
    return this.prisma.goalReflection.findMany({
      where: { userId, goalId },
      orderBy: { weekKey: 'desc' },
      take: 12,
    });
  }

  async upsertReflection(
    userId: string,
    goalId: string,
    dto: UpsertGoalReflectionDto,
  ) {
    await this.assertGoalOwnership(userId, goalId);
    const { weekKey, feel, worked, blocked, nextWeekFocus } = dto;

    const create: Prisma.GoalReflectionUncheckedCreateInput = {
      userId,
      goalId,
      weekKey,
      feel,
    };
    if (worked !== undefined) create.worked = worked;
    if (blocked !== undefined) create.blocked = blocked;
    if (nextWeekFocus !== undefined) create.nextWeekFocus = nextWeekFocus;

    const update: Prisma.GoalReflectionUncheckedUpdateInput = { feel };
    if (worked !== undefined) update.worked = worked;
    if (blocked !== undefined) update.blocked = blocked;
    if (nextWeekFocus !== undefined) update.nextWeekFocus = nextWeekFocus;

    return this.prisma.goalReflection.upsert({
      where: {
        userId_goalId_weekKey: { userId, goalId, weekKey },
      },
      create,
      update,
    });
  }
}
