import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IsIsoWeekKey } from './is-iso-week-key.decorator';

export class GetReflectionQueryDto {
  @ApiPropertyOptional({ example: '2026-W22' })
  @IsOptional()
  @IsString()
  @IsIsoWeekKey()
  weekKey?: string;
}
