import { IsString, IsOptional, IsNumber, IsEnum, IsDateString, Min, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { GoalStatus } from '@prisma/client';
import { Type } from 'class-transformer';

export class LabelInput {
  @ApiProperty({ example: 'Q1' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: '#E2E8F0', description: 'Hex color for the label' })
  @IsOptional()
  @IsString()
  color?: string;
}

export class CreateGoalDto {
  @ApiProperty({ example: 'Learn React' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: 'Complete React course and build 3 projects' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'LEARNING', description: 'Category value from user\'s categories' })
  @IsString()
  category: string;

  @ApiProperty({ example: 40 })
  @IsNumber()
  @Min(1)
  targetHours: number;

  @ApiPropertyOptional({ example: '2025-02-28' })
  @IsOptional()
  @IsDateString()
  deadline?: string;

  @ApiPropertyOptional({ example: '#3B82F6' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ 
    example: [{ name: 'Q1', color: '#FEE2E2' }, { name: 'High Priority', color: '#DBEAFE' }], 
    description: 'Array of label objects with name and optional color' 
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LabelInput)
  labels?: LabelInput[];
}

export class UpdateGoalDto extends PartialType(CreateGoalDto) {
  @ApiPropertyOptional({ enum: GoalStatus })
  @IsOptional()
  @IsEnum(GoalStatus)
  status?: GoalStatus;

  @ApiPropertyOptional({ example: 10.5 })
  @IsOptional()
  @IsNumber()
  loggedHours?: number;
}
