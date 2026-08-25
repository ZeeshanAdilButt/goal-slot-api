import {
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CliAuthMode } from '@prisma/client';

/**
 * WIRE FORMAT: camelCase, matching every other DTO in this repo
 * (`accessToken`, `refreshToken`). This deliberately deviates from RFC 8628,
 * which specifies snake_case (`device_code`, `user_code`, `expires_in`). There
 * is no third-party OAuth client here - only the first-party GoalSlot CLI -
 * so repo consistency wins over spec fidelity. Do not "fix" this toward the
 * RFC later; the CLI is coded against these names.
 *
 * The one exception is the `user_code` query parameter on the device deep link
 * (`verificationUriComplete`), which stays snake_case because it is a URL the
 * user may see and paste, and matching the RFC there costs nothing.
 */

/** Only scope in v1. Enumerated so adding a second one is a compile error away. */
export const CLI_SCOPES = ['full'] as const;
export type CliScope = (typeof CLI_SCOPES)[number];

export class CreateCliSessionDto {
  @ApiProperty({ enum: CliAuthMode, example: CliAuthMode.LOOPBACK })
  @IsEnum(CliAuthMode)
  mode: CliAuthMode;

  @ApiPropertyOptional({
    example: 'http://127.0.0.1:53412/callback',
    description:
      'Required for LOOPBACK. Must be http on 127.0.0.1 or localhost, path /callback, no query or fragment, port 1024-65535.',
  })
  @ValidateIf((dto: CreateCliSessionDto) => dto.mode === CliAuthMode.LOOPBACK)
  @IsString()
  @MaxLength(200)
  redirectUri?: string;

  @ApiPropertyOptional({
    description:
      'Opaque anti-mixup value echoed back on the loopback callback. LOOPBACK only.',
  })
  @IsOptional()
  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9._~-]+$/)
  state?: string;

  @ApiProperty({
    description: 'PKCE code challenge, base64url of sha256(codeVerifier).',
  })
  @IsString()
  @Length(43, 128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  codeChallenge: string;

  @ApiProperty({ example: 'S256', enum: ['S256'] })
  @IsIn(['S256'])
  codeChallengeMethod: 'S256';

  @ApiProperty({ example: 'goalslot-cli' })
  @IsString()
  @Length(1, 64)
  clientName: string;

  @ApiProperty({ example: '0.1.0' })
  @IsString()
  @Length(1, 32)
  clientVersion: string;

  @ApiProperty({ example: 'ZEESHAN-DESK', description: 'os.hostname()' })
  @IsString()
  @Length(1, 64)
  deviceLabel: string;

  @ApiProperty({
    example: 'win32-x64',
    description: '`${process.platform}-${process.arch}`',
  })
  @IsString()
  @Length(1, 32)
  platform: string;

  @ApiPropertyOptional({ example: ['full'], enum: CLI_SCOPES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(CLI_SCOPES as unknown as string[], { each: true })
  scopes?: string[];
}

export class ApproveCliSessionDto {
  @ApiPropertyOptional({ example: ['full'], enum: CLI_SCOPES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(CLI_SCOPES as unknown as string[], { each: true })
  scopes?: string[];
}

export class ExchangeCliTokenDto {
  @ApiProperty()
  @IsUUID()
  sessionId: string;

  @ApiProperty({ example: 'gsl_ss_...' })
  @IsString()
  @Length(20, 200)
  sessionSecret: string;

  @ApiProperty({ description: 'PKCE code verifier.' })
  @IsString()
  @Length(43, 128)
  @Matches(/^[A-Za-z0-9._~-]+$/)
  codeVerifier: string;

  @ApiPropertyOptional({
    example: 'gsl_ac_...',
    description: 'Required for LOOPBACK, absent when polling in DEVICE mode.',
  })
  @IsOptional()
  @IsString()
  @Length(20, 200)
  authorizationCode?: string;
}

export class RefreshCliTokenDto {
  @ApiProperty({ example: 'gsl_rt_...' })
  @IsString()
  @Length(20, 200)
  refreshToken: string;
}

export class RenameCliTokenDto {
  @ApiProperty({ example: 'work laptop' })
  @IsString()
  @Length(1, 64)
  name: string;
}

export class DeviceLookupQueryDto {
  @ApiProperty({ example: 'BXKQ-7TDM' })
  @IsString()
  @Length(8, 12)
  userCode: string;
}
