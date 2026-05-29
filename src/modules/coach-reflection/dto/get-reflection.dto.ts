import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

const WEEK_KEY = /^\d{4}-W\d{2}$/;

export class GetReflectionQueryDto {
  @ApiPropertyOptional({ example: '2026-W22' })
  @IsOptional()
  @IsString()
  @Matches(WEEK_KEY, { message: 'weekKey must match YYYY-Www, e.g. 2026-W22' })
  weekKey?: string;
}
