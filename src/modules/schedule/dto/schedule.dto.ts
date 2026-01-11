import { IsString, IsNumber, IsOptional, IsBoolean, IsUUID, Min, Max, Matches, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class CreateScheduleBlockDto {
  @ApiProperty({ example: 'Deep Work' })
  @IsString()
  title: string;

  @ApiProperty({ example: '09:00', description: 'Start time in HH:mm format' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Start time must be in HH:mm format' })
  startTime: string;

  @ApiProperty({ example: '12:00', description: 'End time in HH:mm format' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'End time must be in HH:mm format' })
  endTime: string;

  @ApiProperty({ example: 1, description: 'Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)' })
  @IsNumber()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: 'DEEP_WORK', description: 'Category value from user\'s categories' })
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

  @ApiPropertyOptional({ description: 'Link to a goal' })
  @IsOptional()
  @IsUUID()
  goalId?: string;

  @ApiPropertyOptional({ description: 'Series identifier used to link related schedule blocks' })
  @IsOptional()
  @IsUUID()
  seriesId?: string;
}

export class UpdateScheduleBlockDto extends PartialType(CreateScheduleBlockDto) {
  @ApiPropertyOptional({
    description: 'Apply the update to only this block or all blocks in the linked series',
    enum: ['single', 'series'],
    default: 'single',
  })
  @IsOptional()
  @IsIn(['single', 'series'])
  updateScope?: 'single' | 'series';
}
