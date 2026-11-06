import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class ListTasksQueryDto {
  @ApiPropertyOptional({ enum: TaskStatus })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({
    enum: TaskStatus,
    isArray: true,
    description: 'Multiple statuses to filter by',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === undefined) return undefined;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return [value];
    return value;
  })
  @IsArray()
  @IsEnum(TaskStatus, { each: true })
  statuses?: TaskStatus[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  scheduleBlockId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  goalId?: string;

  @ApiPropertyOptional({ description: '0 (Sun) - 6 (Sat)' })
  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional({
    enum: ['mine', 'personal'],
    description:
      'mine (default): personal tasks plus project tasks assigned to me or created by me and unassigned. personal: only my personal tasks. Ignored when projectId is set.',
  })
  @IsOptional()
  @IsIn(['mine', 'personal'])
  scope?: 'mine' | 'personal';

  @ApiPropertyOptional({
    description: 'List every task in this project (membership required)',
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'With projectId only: me, unassigned, or a member userId',
  })
  @IsOptional()
  @Matches(
    /^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    { message: 'assignee must be me, unassigned, or a user id' },
  )
  assignee?: string;
}
