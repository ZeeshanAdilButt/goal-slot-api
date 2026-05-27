import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// HH:MM in 24-hour clock — 00:00 .. 23:59
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpsertHabitsProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  why?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  phoneBlockerInstalled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  distractingSubsCancelled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  websiteBlockerUrls?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 16 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16)
  sleepTargetHours?: number;

  @ApiPropertyOptional({ example: '23:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: 'bedtime must match HH:MM' })
  bedtime?: string;

  @ApiPropertyOptional({ example: '07:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: 'wakeTime must match HH:MM' })
  wakeTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  workEnvironment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  additionalContext?: string;
}
