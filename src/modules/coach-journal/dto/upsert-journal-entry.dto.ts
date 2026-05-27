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

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

export class UpsertJournalEntryDto {
  @ApiProperty({ example: '2026-05-27' })
  @IsString()
  @Matches(YYYY_MM_DD, { message: 'date must match YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  mood?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  energy?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  // TipTap HTML can be large; allow up to ~64KB.
  @MaxLength(65535)
  content?: string;
}
