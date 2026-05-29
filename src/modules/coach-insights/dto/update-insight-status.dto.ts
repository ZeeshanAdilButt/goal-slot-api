import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoachInsightStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateInsightStatusDto {
  @ApiProperty({ enum: CoachInsightStatus })
  @IsEnum(CoachInsightStatus)
  status!: CoachInsightStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
