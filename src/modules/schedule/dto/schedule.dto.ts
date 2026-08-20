import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsUUID,
  Min,
  Max,
  Matches,
  IsIn,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class CreateScheduleBlockDto {
  @ApiPropertyOptional({
    description: 'Client-generated id, enabling stable offline creation',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Deep Work' })
  @IsString()
  title: string;

  @ApiProperty({ example: '09:00', description: 'Start time in HH:mm format' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'Start time must be in HH:mm format',
  })
  startTime: string;

  @ApiProperty({ example: '12:00', description: 'End time in HH:mm format' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'End time must be in HH:mm format',
  })
  endTime: string;

  @ApiProperty({
    example: 1,
    description: 'Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)',
  })
  @IsNumber()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({
    example: 'DEEP_WORK',
    description: "Category value from user's categories",
  })
  @IsString()
  category: string;

  @ApiPropertyOptional({ example: '#FFD700' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'When true, hides this block (and its time entries) from anyone the owner has shared their workspace with. Owner always sees it.',
  })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  @ApiPropertyOptional({ description: 'Link to a goal' })
  @IsOptional()
  @IsUUID()
  goalId?: string;

  @ApiPropertyOptional({
    description: 'Series identifier used to link related schedule blocks',
  })
  @IsOptional()
  @IsUUID()
  seriesId?: string;
}

/**
 * One request, one atomic outcome for a multi-day create (schedule-block
 * modal's "select multiple days" flow). Each entry is the same shape as
 * CreateScheduleBlockDto — including its own `seriesId`, since the client
 * mints one shared seriesId and stamps it onto every day's entry itself
 * rather than this DTO inferring it. See ScheduleService.createBatch: every
 * entry's conflict check runs BEFORE any entry is inserted, all inside one
 * Serializable transaction, so a genuine conflict on one day rolls back the
 * whole group instead of leaving the earlier days silently created (the
 * "Time slot conflicts" bug — a fan-out of N parallel POST /schedule calls
 * behind Promise.all had no such guarantee: one 400 still left up to N-1
 * rows committed).
 */
export class CreateScheduleBlocksBatchDto {
  @ApiProperty({
    type: [CreateScheduleBlockDto],
    description:
      'Per-day block payloads to create atomically — all or nothing.',
    maxItems: 7,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => CreateScheduleBlockDto)
  blocks: CreateScheduleBlockDto[];
}

export class UpdateScheduleBlockDto extends PartialType(
  CreateScheduleBlockDto,
) {
  @ApiPropertyOptional({
    description:
      'Apply the update to only this block or all blocks in the linked series',
    enum: ['single', 'series'],
    default: 'single',
  })
  @IsOptional()
  @IsIn(['single', 'series'])
  updateScope?: 'single' | 'series';
}
