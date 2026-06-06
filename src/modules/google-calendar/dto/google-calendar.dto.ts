import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class CalendarSelectionDto {
  @ApiProperty({ description: 'Google calendar id', example: 'primary' })
  @IsString()
  externalCalId: string;

  @ApiProperty({ example: 'Work' })
  @IsString()
  displayName: string;

  @ApiPropertyOptional({ example: '#3B82F6' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiProperty({ enum: ['in', 'out', 'both'], example: 'in' })
  @IsIn(['in', 'out', 'both'])
  syncDirection: 'in' | 'out' | 'both';
}

export class SaveSelectionsDto {
  @ApiProperty({ type: [CalendarSelectionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CalendarSelectionDto)
  selections: CalendarSelectionDto[];
}
