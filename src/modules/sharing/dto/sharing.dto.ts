import { IsEmail, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum AccessLevel {
  VIEW = 'VIEW',
  EDIT = 'EDIT',
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
