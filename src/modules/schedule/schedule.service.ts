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
  CreateScheduleBlocksBatchDto,
  UpdateScheduleBlockDto,
} from './dto/schedule.dto';

// A client that can run `scheduleBlock` queries: either the live
// PrismaService or the `tx` handed to a `$transaction` callback. Lets
// `checkTimeConflict` run either standalone or as part of one atomic
// check-then-insert (see `createWithConflictGuard`).
type ScheduleBlockClient = Pick<PrismaService, 'scheduleBlock'>;

const MAX_CONFLICT_RETRIES = 3;

// Matches CreateScheduleBlockDto.dayOfWeek's documented convention
// (0=Sunday, ..., 6=Saturday). Used only to make a batch conflict message
// self-explanatory ("... on Wednesday") without the client having to map the
// number back to a name itself — the global PostHogExceptionFilter forwards
// only an HttpException's `message`, not any other field on the response
// body, so the day name has to live inside the message string itself rather
// than a sibling `dayOfWeek` field.
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

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

  /**
   * Rejects any block whose end is not strictly after its start.
   *
   * This is the real "schedule still double" root cause, and it is separate
   * from the serializable-transaction race fixed above. `checkTimeConflict`
   * compares raw minute offsets (`newStart < blockEnd && newEnd > blockStart`)
   * with no midnight wrap-around, so for a block like 23:00-00:00 it computes
   * `1380 < 0` — false — even against a byte-identical existing row. The
   * conflict check therefore returns "no conflict" and the duplicate inserts.
   *
   * That duplicates SEQUENTIALLY; no concurrency is involved, which is why
   * the serializable transaction never closed it. A serializable transaction
   * makes a check atomic, it cannot make a wrong check correct: the retry
   * loser re-reads, sees the winner's committed row, evaluates the same
   * broken comparison, gets false, and inserts anyway.
   *
   * Three separate clients could mint such a range:
   *   - mobile quick-add, whose `% (24 * 60)` wrapped every slot created
   *     between 22:30 and 23:29 into 23:00-00:00 or 23:30-00:30
   *     (goalslot-mobile apps/mobile/src/hooks/useQuickAdd.ts);
   *   - the web block modal, which offered all 96 quarter-hours in BOTH
   *     dropdowns with no ordering constraint, so "22:00 -> 08:00" was two
   *     clicks away;
   *   - the Coach proposal path, which routes through this same `create`.
   *
   * Validating here rather than in the DTO is deliberate: it is the single
   * choke point all three share, it also covers `update` (whose
   * `UpdateScheduleBlockDto` is a `PartialType` and so cannot express a
   * cross-field rule at all), and it protects installed mobile builds that
   * will never receive the client-side fix.
   *
   * Note the side effect this also cures: an inverted row overlaps nothing,
   * so it was invisible to conflict detection permanently — duplicable
   * without limit, and never blocking any other create.
   */
  private assertValidRange(startTime: string, endTime: string) {
    if (this.timeToMinutes(endTime) <= this.timeToMinutes(startTime)) {
      throw new BadRequestException('End time must be after start time');
    }
  }

  async create(userId: string, dto: CreateScheduleBlockDto) {
    this.assertValidRange(dto.startTime, dto.endTime);
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

  /**
   * Atomic counterpart to `create` for a GROUP of blocks that logically
   * belong together (schedule-block modal's "select multiple days" flow,
   * which shares one `seriesId` across the group).
   *
   * Before this endpoint existed, the web client fanned the group out into N
   * parallel `POST /schedule` calls via `Promise.all`. `Promise.all` fails
   * fast on the first rejection, but the other requests were already
   * in-flight on the server and completed independently — there was no
   * transaction spanning the group. If even one day genuinely conflicted,
   * that day 400'd, the caller saw ONE error and assumed nothing happened,
   * while up to N-1 blocks were silently created. This is that fix: every
   * day in the batch is checked for a conflict BEFORE any of them are
   * inserted, all inside one transaction, so a conflict on one day rolls
   * back the whole group — zero blocks created, not N-1 — exactly like
   * `createWithConflictGuard` does for a single block.
   */
  async createBatch(userId: string, dto: CreateScheduleBlocksBatchDto) {
    for (const block of dto.blocks) {
      this.assertValidRange(block.startTime, block.endTime);
    }

    // Dedupe goalIds so a batch that links every day to the same goal (the
    // common case) only pays for one ownership lookup, not N.
    const goalIds = new Set(
      dto.blocks.map((b) => b.goalId).filter((id): id is string => !!id),
    );
    for (const goalId of goalIds) {
      await this.validateGoalOwnership(userId, goalId);
    }

    // Same plan-limit gate as the single-create path, applied once per block
    // being added — i.e. as if the caller had run `create` N times in a row.
    // Deliberately outside the transaction below (same looseness the
    // existing single-create path already accepts: this check and the
    // conflict-guarded insert are not one atomic unit against a *concurrent*
    // create elsewhere, only against each other within this batch).
    const currentSchedules = await this.prisma.scheduleBlock.count({
      where: { userId },
    });
    for (let i = 0; i < dto.blocks.length; i++) {
      await this.authService.checkPlanLimit(
        userId,
        'schedules',
        currentSchedules + i,
      );
    }

    return this.createBatchWithConflictGuard(userId, dto);
  }

  /**
   * Same SERIALIZABLE check-then-insert pattern as `createWithConflictGuard`
   * (see that method's comment for the race it closes), extended to a group:
   *
   *   1. Check every block in the batch against the *committed* table state
   *      for a conflict. Nothing is inserted yet, so this phase alone would
   *      miss two entries in the SAME batch conflicting with each other.
   *   2. Guard against that separately, in-memory, before touching the DB:
   *      group the batch by dayOfWeek and pairwise-check overlaps within
   *      each group. The web client can't actually produce this today (its
   *      day picker dedupes selections), but the endpoint's contract
   *      ("all-or-nothing for whatever's in the array") shouldn't silently
   *      depend on that.
   *   3. Only once every block has cleared both checks are any rows
   *      inserted, all inside the same transaction.
   *
   * A conflict at either phase throws and rolls back the whole transaction —
   * zero rows created — and identifies which day it was in the message
   * (see DAY_NAMES).
   */
  private async createBatchWithConflictGuard(
    userId: string,
    dto: CreateScheduleBlocksBatchDto,
    attempt = 0,
  ): Promise<
    Array<Awaited<ReturnType<PrismaService['scheduleBlock']['create']>>>
  > {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          this.assertNoSelfConflict(dto.blocks);

          for (const block of dto.blocks) {
            const hasConflict = await this.checkTimeConflict(
              userId,
              block.dayOfWeek,
              block.startTime,
              block.endTime,
              undefined,
              tx,
            );
            if (hasConflict) {
              throw new BadRequestException(
                `Time slot conflicts with an existing schedule block on ${DAY_NAMES[block.dayOfWeek]}`,
              );
            }
          }

          const created: Array<
            Awaited<ReturnType<PrismaService['scheduleBlock']['create']>>
          > = [];
          for (const block of dto.blocks) {
            created.push(
              await tx.scheduleBlock.create({
                data: {
                  ...block,
                  id: block.id ?? undefined,
                  userId,
                },
                include: { goal: true },
              }),
            );
          }
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationFailure(error) && attempt < MAX_CONFLICT_RETRIES) {
        return this.createBatchWithConflictGuard(userId, dto, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Pairwise overlap check across entries of the SAME batch, for the day
   * they'd land on. Independent of `checkTimeConflict`, which only ever
   * compares a candidate against rows already committed to the table — two
   * not-yet-inserted entries in this same call are invisible to each other
   * there.
   */
  private assertNoSelfConflict(blocks: CreateScheduleBlockDto[]) {
    const byDay = new Map<number, CreateScheduleBlockDto[]>();
    for (const block of blocks) {
      const group = byDay.get(block.dayOfWeek) ?? [];
      group.push(block);
      byDay.set(block.dayOfWeek, group);
    }

    for (const [dayOfWeek, group] of byDay) {
      for (let i = 0; i < group.length; i++) {
        const a = group[i];
        const aStart = this.timeToMinutes(a.startTime);
        const aEnd = this.timeToMinutes(a.endTime);
        for (let j = i + 1; j < group.length; j++) {
          const b = group[j];
          const bStart = this.timeToMinutes(b.startTime);
          const bEnd = this.timeToMinutes(b.endTime);
          if (aStart < bEnd && aEnd > bStart) {
            throw new BadRequestException(
              `Two blocks in this request overlap on ${DAY_NAMES[dayOfWeek]}`,
            );
          }
        }
      }
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
          // Merged effective values, not the raw patch: a request that sends
          // only `startTime: '23:00'` against a block ending 10:00 inverts
          // that block, and the patch alone doesn't show it.
          this.assertValidRange(nextStart, nextEnd);
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

    if (updateData.startTime || updateData.endTime) {
      // Same merge rule as the series branch above. Without this an existing
      // healthy block could be edited INTO an inverted range, after which it
      // became invisible to `checkTimeConflict` and freely duplicable.
      this.assertValidRange(
        updateData.startTime ?? block.startTime,
        updateData.endTime ?? block.endTime,
      );
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
