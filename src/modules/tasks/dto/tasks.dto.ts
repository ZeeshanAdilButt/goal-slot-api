import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, IsEnum, IsNumber, Min, IsDateString } from 'class-validator';
import { TaskStatus } from '@prisma/client';

export class CreateTaskDto {
  @ApiProperty({ example: 'Write weekly report' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: 'Summarize accomplishments and blockers' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: TaskStatus })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ example: 90, description: 'Estimated minutes' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedMinutes?: number;

  @ApiPropertyOptional({ description: 'Link to a goal' })
  @IsOptional()
  @IsUUID()
  goalId?: string;

  @ApiPropertyOptional({ description: 'Link to a schedule block' })
  @IsOptional()
  @IsUUID()
  scheduleBlockId?: string;

  @ApiPropertyOptional({ description: 'Due date for the task' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateTaskDto extends PartialType(CreateTaskDto) {}

export class CompleteTaskDto {
  @ApiProperty({ example: 60, description: 'Actual minutes spent' })
  @IsNumber()
  @Min(1)
  actualMinutes: number;

  @ApiPropertyOptional({ example: 'Finished earlier than expected' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ example: '2025-12-07', description: 'Date to log the completion' })
  @IsOptional()
  @IsDateString()
  date?: string;
}




