import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListTasksQueryDto {
  @ApiPropertyOptional({ enum: TaskStatus })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

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
  @Transform(({ value }) => (value === '' || value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;
}
