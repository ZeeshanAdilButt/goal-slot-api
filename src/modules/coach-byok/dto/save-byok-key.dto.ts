import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MinLength } from 'class-validator';
import { CoachProvider } from '@prisma/client';

export class SaveByokKeyDto {
  @ApiProperty({ enum: CoachProvider, description: 'LLM provider for the BYOK key' })
  @IsEnum(CoachProvider)
  provider!: CoachProvider;

  @ApiProperty({ description: 'Provider API key (will be encrypted at rest)' })
  @IsString()
  @MinLength(8)
  apiKey!: string;
}
