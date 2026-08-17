import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsNumber,
  Min,
  IsDateString,
  ValidateIf,
} from 'class-validator';
import { TaskStatus } from '@prisma/client';

export class CreateTaskDto {
  @ApiPropertyOptional({
    description: 'Client-generated id, enabling stable offline creation',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Write weekly report' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: 'Summarize accomplishments and blockers' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'DEEP_WORK', description: 'Task category' })
  @IsOptional()
  @IsString()
  category?: string;

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

  @ApiPropertyOptional({ description: 'Task-specific notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * `dueDate` is omitted from the inherited shape and redeclared below so it can
 * accept an explicit `null`. Creating a task with a null due date is
 * meaningless (just leave the field out), but UPDATING one to null is the only
 * way a client can say "clear this" — omitting the key means "leave
 * unchanged". Widening `CreateTaskDto.dueDate` instead would let a null through
 * on create for no benefit, and TS rejects narrowing-vs-base anyway.
 */
export class UpdateTaskDto extends PartialType(
  OmitType(CreateTaskDto, ['dueDate'] as const),
) {
  /**
   * The runtime validator already tolerated null — class-validator's
   * `@IsOptional` skips every other decorator for null as well as undefined —
   * so the payload was never what blocked clearing; `update` in the service
   * was. What actually changes here is the TYPE and the API contract: the
   * field is now `string | null`, so the service can branch on null instead of
   * having it silently widened away, and Swagger documents null as meaningful.
   * `@ValidateIf` is belt-and-braces, making the intent explicit rather than
   * leaving it resting on `@IsOptional`'s null handling. Every other value is
   * validated exactly as before — 'today', 'ASAP' and '' are still rejected.
   */
  @ApiPropertyOptional({
    description: 'Due date for the task; null clears an existing due date',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsDateString()
  dueDate?: string | null;
}

export class CompleteTaskDto {
  @ApiProperty({ example: 60, description: 'Actual minutes spent' })
  @IsNumber()
  @Min(1)
  actualMinutes: number;

  @ApiPropertyOptional({ example: 'Finished earlier than expected' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    example: '2025-12-07',
    description: 'Date to log the completion',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
