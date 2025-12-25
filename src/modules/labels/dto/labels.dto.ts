import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class CreateLabelDto {
  @ApiProperty({ example: 'Q1 2025' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: '#3B82F6' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  order?: number;
}

export class UpdateLabelDto extends PartialType(CreateLabelDto) {}

export class AssignLabelsDto {
  @ApiProperty({ example: ['label-id-1', 'label-id-2'] })
  @IsArray()
  @IsString({ each: true })
  labelIds: string[];
}
