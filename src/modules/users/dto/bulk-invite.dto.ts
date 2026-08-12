import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { ASSIGNABLE_USER_ROLES } from './users.dto';

export class BulkInviteDto {
  @ApiProperty({
    description:
      'Free-form text containing emails. Commas, spaces, newlines, semicolons, and angle brackets all work as separators. Anything that looks like an email gets picked up, deduped (case-insensitive), and processed.',
    example: 'alice@example.com, bob@example.com\nclaire@example.com',
  })
  @IsString()
  @MinLength(3)
  text: string;

  @ApiPropertyOptional({
    enum: ASSIGNABLE_USER_ROLES,
    default: UserRole.USER,
    description:
      'Role applied to every invitee in this batch. Defaults to USER. SUPER_ADMIN cannot be assigned here.',
  })
  @IsOptional()
  @IsIn(ASSIGNABLE_USER_ROLES as readonly UserRole[])
  role?: UserRole;
}

export interface BulkInviteRow {
  email: string;
  status: 'invited' | 'already_user' | 'invalid' | 'failed';
  reason?: string;
  userId?: string;
}

export interface BulkInviteResponse {
  total: number;
  invited: number;
  alreadyUsers: number;
  invalid: number;
  failed: number;
  rows: BulkInviteRow[];
}
