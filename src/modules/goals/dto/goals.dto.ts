import { IsString, IsOptional, IsNumber, IsEnum, IsDateString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { GoalCategory, GoalStatus } from '@prisma/client';

export class CreateGoalDto {
  @ApiProperty({ example: 'Learn React' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: 'Complete React course and build 3 projects' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: GoalCategory, example: 'LEARNING' })
  @IsEnum(GoalCategory)
  category: GoalCategory;

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
