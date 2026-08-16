import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import {
  CreateScheduleBlockDto,
  UpdateScheduleBlockDto,
} from './dto/schedule.dto';

// A client that can run `scheduleBlock` queries: either the live
// PrismaService or the `tx` handed to a `$transaction` callback. Lets
// `checkTimeConflict` run either standalone or as part of one atomic
// check-then-insert (see `createWithConflictGuard`).
type ScheduleBlockClient = Pick<PrismaService, 'scheduleBlock'>;

const MAX_CONFLICT_RETRIES = 3;

@Injectable()
export class ScheduleService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
  ) {}

  /**
   * goalId is client-supplied, so it has to be confirmed to belong to the
   * caller before it's written onto a schedule block. Without this a caller
   * could link their own block to a stranger's goal and read that goal back
   * out of the `include: { goal: true }` response (mirrors
   * TasksService.validateRelations / TimeEntriesService.validateRelations,
   * which guard the same relation elsewhere in the codebase).
   */
  private async validateGoalOwnership(userId: string, goalId?: string | null) {
    if (!goalId) return;
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });
    if (!goal) {
      throw new ForbiddenException('Goal not found or access denied');
    }
  }

  async create(userId: string, dto: CreateScheduleBlockDto) {
    await this.validateGoalOwnership(userId, dto.goalId);

    // Check plan limits
    const currentSchedules = await this.prisma.scheduleBlock.count({
      where: { userId },
    });
    await this.authService.checkPlanLimit(
      userId,
      'schedules',
      currentSchedules,
    );

    return this.createWithConflictGuard(userId, dto);
  }

  /**
   * The time-conflict check and the insert used to be two separate
   * statements — `checkTimeConflict` then `prisma.scheduleBlock.create` —
   * with nothing between them. Two concurrent creates for the same slot
   * (a double-tap before the button disables, a client retry racing its
   * own still-in-flight original attempt, or two different
   * clients/idempotency keys — mobile, web, Coach — landing at the same
   * moment) could both run the check, both see "no conflict" because
   * neither had written yet, and both insert: two real overlapping rows
   * for one logical booking. That's the "schedule still double" bug.
   *
   * Client-side idempotency keys (goalslot-mobile@83d5536) don't close
   * this on their own — they only dedupe a literal retry carrying the
   * *same* key, not two different requests racing each other for the
   * same slot.
   *
   * Running the check + insert inside one SERIALIZABLE transaction closes
   * the window: Postgres's serializable snapshot isolation tracks the
   * read (the conflict-check SELECT) against the write (the INSERT) and
   * detects exactly this phantom-read pattern between two concurrent
   * transactions, aborting the loser with a retryable serialization
   * failure (P2034) instead of letting both commit. The loser is retried
   * a few times so it gets a fair second look once the winner has
   * committed — at which point its own conflict check correctly sees the
   * winner's row and throws the normal 400 instead of silently
   * duplicating it.
   */
  private async createWithConflictGuard(
    userId: string,
    dto: CreateScheduleBlockDto,
    attempt = 0,
  ): Promise<Awaited<ReturnType<PrismaService['scheduleBlock']['create']>>> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const hasConflict = await this.checkTimeConflict(
            userId,
            dto.dayOfWeek,
            dto.startTime,
            dto.endTime,
            undefined,
            tx,
          );
          if (hasConflict) {
            throw new BadRequestException(
              'Time slot conflicts with an existing schedule block',
            );
          }

          return tx.scheduleBlock.create({
            data: {
              ...dto,
              id: dto.id ?? undefined,
              userId,
            },
            include: { goal: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationFailure(error) && attempt < MAX_CONFLICT_RETRIES) {
        return this.createWithConflictGuard(userId, dto, attempt + 1);
      }
      throw error;
    }
  }

  async findAll(userId: string) {
    return this.prisma.scheduleBlock.findMany({
      where: { userId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      include: {
        goal: {
          select: { id: true, title: true, color: true, category: true },
        },
        tasks: {
          select: { id: true, title: true, status: true },
        },
      },
    });
  }

  async findByDay(userId: string, dayOfWeek: number) {
    return this.prisma.scheduleBlock.findMany({
      where: { userId, dayOfWeek },
      orderBy: { startTime: 'asc' },
      include: { goal: true },
    });
  }

  async update(userId: string, blockId: string, dto: UpdateScheduleBlockDto) {
    const block = await this.prisma.scheduleBlock.findFirst({
      where: { id: blockId, userId },
      include: { goal: true },
    });

    if (!block) {
      throw new NotFoundException('Schedule block not found');
    }

    const {
      id: _id,
      updateScope = 'single',
      seriesId: _ignoredSeriesId,
      ...changes
    } = dto;
    const updateData = this.removeUndefined(changes);

    await this.validateGoalOwnership(userId, updateData.goalId);

    if (updateScope === 'series' && block.seriesId) {
      const sanitizedSeriesData = {
        ...updateData,
      } as Partial<CreateScheduleBlockDto>;
      if ('dayOfWeek' in sanitizedSeriesData) {
        delete sanitizedSeriesData.dayOfWeek;
      }

      const hasTimeUpdate = Boolean(
        sanitizedSeriesData.startTime || sanitizedSeriesData.endTime,
      );

      if (Object.keys(sanitizedSeriesData).length === 0) {
        return block;
      }

      if (hasTimeUpdate) {
        const seriesBlocks = await this.prisma.scheduleBlock.findMany({
          where: { userId, seriesId: block.seriesId },
        });

        for (const seriesBlock of seriesBlocks) {
          const targetDay = seriesBlock.dayOfWeek;
          const nextStart =
            sanitizedSeriesData.startTime ?? seriesBlock.startTime;
          const nextEnd = sanitizedSeriesData.endTime ?? seriesBlock.endTime;
          const conflict = await this.checkTimeConflict(
            userId,
            targetDay,
            nextStart,
            nextEnd,
            seriesBlock.id,
          );
          if (conflict) {
            throw new BadRequestException(
              'Time slot conflicts with an existing schedule block in this series',
            );
          }
        }
      }

      await this.prisma.scheduleBlock.updateMany({
        where: { userId, seriesId: block.seriesId },
        data: sanitizedSeriesData,
      });

      return this.prisma.scheduleBlock.findFirst({
        where: { id: blockId },
        include: { goal: true },
      });
    }

    if (
      updateData.startTime ||
      updateData.endTime ||
      updateData.dayOfWeek !== undefined
    ) {
      const hasConflict = await this.checkTimeConflict(
        userId,
        updateData.dayOfWeek ?? block.dayOfWeek,
        updateData.startTime ?? block.startTime,
        updateData.endTime ?? block.endTime,
        blockId,
      );
      if (hasConflict) {
        throw new BadRequestException(
          'Time slot conflicts with an existing schedule block',
        );
      }
    }

    return this.prisma.scheduleBlock.update({
      where: { id: blockId },
      data: updateData,
      include: { goal: true },
    });
  }

  async delete(userId: string, blockId: string) {
    const block = await this.prisma.scheduleBlock.findFirst({
      where: { id: blockId, userId },
    });

    if (!block) {
      throw new NotFoundException('Schedule block not found');
    }

    await this.prisma.scheduleBlock.delete({ where: { id: blockId } });
    return { message: 'Schedule block deleted' };
  }

  // Wipe every schedule block for the user. Returns the count so the UI can
  // show "N blocks cleared". Used by the destructive "Clear all" button on
  // the schedule page.
  async clearAll(userId: string): Promise<{ deleted: number }> {
    const result = await this.prisma.scheduleBlock.deleteMany({
      where: { userId },
    });
    return { deleted: result.count };
  }

  private async checkTimeConflict(
    userId: string,
    dayOfWeek: number,
    startTime: string,
    endTime: string,
    excludeId?: string,
    client: ScheduleBlockClient = this.prisma,
  ): Promise<boolean> {
    const blocks = await client.scheduleBlock.findMany({
      where: {
        userId,
        dayOfWeek,
        id: excludeId ? { not: excludeId } : undefined,
      },
    });

    const newStart = this.timeToMinutes(startTime);
    const newEnd = this.timeToMinutes(endTime);

    for (const block of blocks) {
      const blockStart = this.timeToMinutes(block.startTime);
      const blockEnd = this.timeToMinutes(block.endTime);

      // Check if times overlap
      if (newStart < blockEnd && newEnd > blockStart) {
        return true;
      }
    }

    return false;
  }

  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private removeUndefined<T extends Record<string, unknown>>(data: T): T {
    return Object.entries(data).reduce((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key as keyof T] = value as T[keyof T];
      }
      return acc;
    }, {} as T);
  }

  async getWeeklySchedule(userId: string) {
    const blocks = await this.findAll(userId);

    // Group by day
    const weekSchedule: Record<
      number,
      Awaited<ReturnType<typeof this.findAll>>
    > = {
      0: [],
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
    };

    blocks.forEach((block) => {
      weekSchedule[block.dayOfWeek].push(block);
    });

    return weekSchedule;
  }
}

/**
 * Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError` so
 * the check keeps working against the fake Prisma client used in unit tests
 * (mirrors `isUniqueViolation` in active-timer.service.ts, which guards the
 * analogous check-then-write race on session start).
 */
function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2034'
  );
}
