import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { CreateScheduleBlockDto, UpdateScheduleBlockDto } from './dto/schedule.dto';

@Injectable()
export class ScheduleService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
  ) {}

  async create(userId: string, dto: CreateScheduleBlockDto) {
    // Check plan limits
    const currentSchedules = await this.prisma.scheduleBlock.count({ where: { userId } });
    await this.authService.checkPlanLimit(userId, 'schedules', currentSchedules);

    // Check for time conflicts
    const hasConflict = await this.checkTimeConflict(userId, dto.dayOfWeek, dto.startTime, dto.endTime);
    if (hasConflict) {
      throw new BadRequestException('Time slot conflicts with an existing schedule block');
    }

    return this.prisma.scheduleBlock.create({
      data: {
        ...dto,
        userId,
      },
      include: { goal: true },
    });
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

    const { updateScope = 'single', seriesId: _ignoredSeriesId, ...changes } = dto;
    const updateData = this.removeUndefined(changes);

    if (updateScope === 'series' && block.seriesId) {
      const sanitizedSeriesData = { ...updateData } as Partial<CreateScheduleBlockDto>;
      if ('dayOfWeek' in sanitizedSeriesData) {
        delete sanitizedSeriesData.dayOfWeek;
      }

      const hasTimeUpdate = Boolean(sanitizedSeriesData.startTime || sanitizedSeriesData.endTime);

      if (Object.keys(sanitizedSeriesData).length === 0) {
        return block;
      }

      if (hasTimeUpdate) {
        const seriesBlocks = await this.prisma.scheduleBlock.findMany({
          where: { userId, seriesId: block.seriesId },
        });

        for (const seriesBlock of seriesBlocks) {
          const targetDay = seriesBlock.dayOfWeek;
          const nextStart = sanitizedSeriesData.startTime ?? seriesBlock.startTime;
          const nextEnd = sanitizedSeriesData.endTime ?? seriesBlock.endTime;
          const conflict = await this.checkTimeConflict(userId, targetDay, nextStart, nextEnd, seriesBlock.id);
          if (conflict) {
            throw new BadRequestException('Time slot conflicts with an existing schedule block in this series');
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

    if (updateData.startTime || updateData.endTime || updateData.dayOfWeek !== undefined) {
      const hasConflict = await this.checkTimeConflict(
        userId,
        updateData.dayOfWeek ?? block.dayOfWeek,
        updateData.startTime ?? block.startTime,
        updateData.endTime ?? block.endTime,
        blockId,
      );
      if (hasConflict) {
        throw new BadRequestException('Time slot conflicts with an existing schedule block');
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

  private async checkTimeConflict(
    userId: string,
    dayOfWeek: number,
    startTime: string,
    endTime: string,
    excludeId?: string,
  ): Promise<boolean> {
    const blocks = await this.prisma.scheduleBlock.findMany({
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

  private removeUndefined<T extends Record<string, any>>(data: T): T {
    return Object.entries(data).reduce((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key as keyof T] = value;
      }
      return acc;
    }, {} as T);
  }

  async getWeeklySchedule(userId: string) {
    const blocks = await this.findAll(userId);
    
    // Group by day
    const weekSchedule: Record<number, any[]> = {
      0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [],
    };

    blocks.forEach((block) => {
      weekSchedule[block.dayOfWeek].push(block);
    });

    return weekSchedule;
  }
}
