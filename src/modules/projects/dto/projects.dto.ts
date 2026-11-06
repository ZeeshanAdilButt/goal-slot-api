import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateProjectDto {
  @ApiProperty({ example: 'Website relaunch' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: '#2563EB' })
  @IsOptional()
  @Matches(HEX_COLOR, { message: 'color must be a hex color like #2563EB' })
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: '#2563EB' })
  @IsOptional()
  @Matches(HEX_COLOR, { message: 'color must be a hex color like #2563EB' })
  color?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null clears it' })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    description:
      'true archives the project (sets archivedAt), false restores it',
  })
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ProjectRole })
  @IsEnum(ProjectRole)
  role: ProjectRole;
}

export class CreateProjectInvitesDto {
  @ApiProperty({ type: [String], example: ['teammate@example.com'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  emails: string[];

  @ApiPropertyOptional({ enum: ProjectRole, default: ProjectRole.MEMBER })
  @IsOptional()
  @IsEnum(ProjectRole)
  role?: ProjectRole;
}

export class ProjectInviteLinkDto {
  @ApiPropertyOptional({
    enum: [ProjectRole.MEMBER, ProjectRole.GUEST],
    default: ProjectRole.MEMBER,
  })
  @IsOptional()
  @IsIn([ProjectRole.MEMBER, ProjectRole.GUEST])
  role?: ProjectRole;
}
