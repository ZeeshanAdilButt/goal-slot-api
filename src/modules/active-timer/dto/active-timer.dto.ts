import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Attribution is optional everywhere and explicitly clearable.
 *
 * `@IsOptional()` skips validation for BOTH `undefined` and `null`, and the
 * global ValidationPipe runs with `whitelist: true`, so a declared property
 * sent as `null` survives into the DTO. The service uses that distinction:
 * `undefined` means "leave it alone", `null` means "detach it". Without the
 * distinction there would be no way to remove a goal from a running session.
 */
class AttributionFieldsDto {
  @ApiPropertyOptional({
    example: 'Refactoring the timer store',
    nullable: true,
    description: 'Free-text label for what is being worked on',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  taskName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Goal to attribute the time to',
  })
  @IsOptional()
  @IsUUID()
  goalId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Task to attribute the time to',
  })
  @IsOptional()
  @IsUUID()
  taskId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Schedule block to attribute the time to',
  })
  @IsOptional()
  @IsUUID()
  scheduleBlockId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Notes carried onto the resulting time entry',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string | null;
}

export class StartTimerSessionDto extends AttributionFieldsDto {
  /**
   * Opt-in takeover. Default (false / omitted) is a hard 409 when a session
   * already exists so the two clients cannot silently fight; see
   * ActiveTimerService.start for the reasoning.
   */
  @ApiPropertyOptional({
    default: false,
    description:
      'Replace an existing active session instead of failing with 409. ' +
      'The replaced session is DISCARDED (no time entry is written) — call ' +
      'POST /timer/session/stop first if the elapsed time should be kept.',
  })
  @IsOptional()
  @IsBoolean()
  takeOver?: boolean;

  @ApiPropertyOptional({
    example: 'web',
    enum: ['web', 'ios', 'android', 'unknown'],
    description:
      'Which client started this, purely so the takeover prompt can name it',
  })
  @IsOptional()
  @IsIn(['web', 'ios', 'android', 'unknown'])
  client?: string;
}

export class UpdateTimerSessionDto extends AttributionFieldsDto {
  @ApiPropertyOptional({
    example: 'web',
    enum: ['web', 'ios', 'android', 'unknown'],
  })
  @IsOptional()
  @IsIn(['web', 'ios', 'android', 'unknown'])
  client?: string;
}

export class StopTimerSessionDto extends AttributionFieldsDto {
  @ApiPropertyOptional({
    example: 'web',
    enum: ['web', 'ios', 'android', 'unknown'],
  })
  @IsOptional()
  @IsIn(['web', 'ios', 'android', 'unknown'])
  client?: string;
}
