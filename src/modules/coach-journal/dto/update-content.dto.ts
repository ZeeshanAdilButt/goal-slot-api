import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UpdateJournalContentDto {
  @ApiProperty({ description: 'Full TipTap HTML body (may be empty string)' })
  @IsString()
  @MaxLength(65535)
  content!: string;
}
