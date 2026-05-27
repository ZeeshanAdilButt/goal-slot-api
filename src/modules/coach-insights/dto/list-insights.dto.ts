import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export type InsightStatusFilter =
  | 'ACTIVE'
  | 'PROPOSED'
  | 'ACCEPTED'
  | 'DOING'
  | 'DONE'
  | 'DISMISSED'
  | 'SAVED'
  | 'ALL';

export const INSIGHT_STATUS_FILTERS: InsightStatusFilter[] = [
  'ACTIVE',
  'PROPOSED',
  'ACCEPTED',
  'DOING',
  'DONE',
  'DISMISSED',
  'SAVED',
  'ALL',
];

export class ListInsightsDto {
  @ApiPropertyOptional({
    enum: [
      'ACTIVE',
      'PROPOSED',
      'ACCEPTED',
      'DOING',
      'DONE',
      'DISMISSED',
      'SAVED',
      'ALL',
    ],
  })
  @IsOptional()
  @IsIn(INSIGHT_STATUS_FILTERS)
  status?: InsightStatusFilter;
}
