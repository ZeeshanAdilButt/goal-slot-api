import { IsString, IsNumber, IsOptional, IsDateString, IsUUID, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class CreateTimeEntryDto {
  @ApiProperty({ example: 'Working on React components' })
  @IsString()
  taskName: string;

  @ApiProperty({ example: 60, description: 'Duration in minutes' })
  @IsNumber()
  @Min(1)
  duration: number;

  @ApiProperty({ example: '2025-12-02' })
  @IsDateString()
  date: string;

  @ApiPropertyOptional({ example: 'Completed header and footer components' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ example: '2025-12-02T09:00:00Z', description: 'When the work started' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({ example: 'Implement login page', description: 'Snapshot of task title' })
  @IsOptional()
  @IsString()
  taskTitle?: string;

  @ApiPropertyOptional({ description: 'Link to a goal' })
  @IsOptional()
  @IsUUID()
  goalId?: string;

  @ApiPropertyOptional({ description: 'Link to a schedule block' })
  @IsOptional()
  @IsUUID()
  scheduleBlockId?: string;

  @ApiPropertyOptional({ description: 'Link to a task (auto-set when completing tasks)' })
  @IsOptional()
  @IsUUID()
  taskId?: string;
}

export class UpdateTimeEntryDto extends PartialType(CreateTimeEntryDto) {}
