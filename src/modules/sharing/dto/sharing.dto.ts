import { IsEmail, IsEnum, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum AccessLevel {
  VIEW = 'VIEW',
  EDIT = 'EDIT',
}

export enum ShareType {
  EMAIL_INVITE = 'EMAIL_INVITE',
  PUBLIC_LINK = 'PUBLIC_LINK',
}

export class InviteUserDto {
  @ApiProperty({ example: 'friend@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: AccessLevel, required: false, default: AccessLevel.VIEW })
  @IsOptional()
  @IsEnum(AccessLevel)
  accessLevel?: AccessLevel;
}

export class CreatePublicLinkDto {
  @ApiProperty({ enum: AccessLevel, required: false, default: AccessLevel.VIEW })
  @IsOptional()
  @IsEnum(AccessLevel)
  accessLevel?: AccessLevel;

  @ApiProperty({ description: 'Number of days until the link expires (1-365)', default: 30 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

export interface PublicLinkResponse {
  id: string;
  publicLink: string;
  token: string;
  expiresAt: Date;
  accessLevel: AccessLevel;
  createdAt: Date;
}
