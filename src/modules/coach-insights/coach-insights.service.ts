import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { CoachInsightStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InsightStatusFilter } from './dto/list-insights.dto';

const ACTIVE_STATUSES: CoachInsightStatus[] = ['PROPOSED', 'ACCEPTED', 'DOING'];

const NON_DELETABLE_STATUSES: CoachInsightStatus[] = [
  'ACCEPTED',
  'DOING',
  'DONE',
  'SAVED',
];

@Injectable()
export class CoachInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, filter?: InsightStatusFilter) {
    const where: Prisma.CoachInsightWhereInput = { userId };
    const f: InsightStatusFilter = filter ?? 'ACTIVE';
    if (f === 'ACTIVE') {
      where.status = { in: ACTIVE_STATUSES };
    } else if (f !== 'ALL') {
      where.status = f as CoachInsightStatus;
    }
    return this.prisma.coachInsight.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  async findOne(userId: string, id: string) {
    const row = await this.prisma.coachInsight.findFirst({
      where: { id, userId },
    });
    if (!row) throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    return row;
  }

  async updateStatus(
    userId: string,
    id: string,
    status: CoachInsightStatus,
    note?: string,
  ) {
    const existing = await this.prisma.coachInsight.findFirst({
      where: { id, userId },
    });
    if (!existing) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    const data: Prisma.CoachInsightUncheckedUpdateInput = { status };
    if (status === 'ACCEPTED' && !existing.acceptedAt)
      data.acceptedAt = new Date();
    if (status === 'DOING' && !existing.startedDoingAt)
      data.startedDoingAt = new Date();
    if (status === 'DONE') data.completedAt = new Date();
    if (status === 'DISMISSED') data.dismissedAt = new Date();
    if (status === 'SAVED' && !existing.savedAt) data.savedAt = new Date();
    if (note !== undefined) data.userNote = note;

    return this.prisma.coachInsight.update({ where: { id }, data });
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.coachInsight.findFirst({
      where: { id, userId },
    });
    if (!existing) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    if (NON_DELETABLE_STATUSES.includes(existing.status)) {
      throw new HttpException(
        'Cannot delete an insight in an accountability state',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.coachInsight.delete({ where: { id } });
    return { success: true } as const;
  }
}
