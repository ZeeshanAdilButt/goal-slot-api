import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { YYYY_MM_DD } from '../date';

export class ListJournalEntriesDto {
  @ApiPropertyOptional({ example: '2026-03-27' })
  @IsOptional()
  @IsString()
  @Matches(YYYY_MM_DD, { message: 'from must match YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-05-27' })
  @IsOptional()
  @IsString()
  @Matches(YYYY_MM_DD, { message: 'to must match YYYY-MM-DD' })
  to?: string;
}
