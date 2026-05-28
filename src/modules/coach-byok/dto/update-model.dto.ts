import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * Update which specific provider model the user wants Coach to call. The
 * value MUST appear in the LlmFactory whitelist for the current provider,
 * else the service throws 400. Backend keeps the whitelist authoritative so
 * we cannot accidentally bill the user against a model we have not
 * validated.
 */
export class UpdateModelDto {
  @ApiProperty({
    description: 'Model id from the allowed list (e.g. "gpt-4o-mini")',
    example: 'gpt-4o-mini',
  })
  @IsString()
  @MinLength(1)
  model!: string;
}
