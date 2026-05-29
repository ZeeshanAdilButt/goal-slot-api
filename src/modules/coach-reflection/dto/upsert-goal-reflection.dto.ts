import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const WEEK_KEY = /^\d{4}-W\d{2}$/;

export class UpsertGoalReflectionDto {
  @ApiProperty({ example: '2026-W22' })
  @IsString()
  @Matches(WEEK_KEY, { message: 'weekKey must match YYYY-Www, e.g. 2026-W22' })
  weekKey!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  feel!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  worked?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  blocked?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  nextWeekFocus?: string;
}
