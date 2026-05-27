import { ApiProperty } from '@nestjs/swagger';
import { CoachProvider } from '@prisma/client';

export type ByokStatus = 'unset' | 'active';

export class ByokStateDto {
  @ApiProperty({ enum: ['unset', 'active'] })
  status!: ByokStatus;

  @ApiProperty({ enum: CoachProvider, required: false, nullable: true })
  provider?: CoachProvider | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Masked hint like "sk-ant-...A4f9" — never the raw key',
  })
  maskedKey?: string | null;

  @ApiProperty({ required: false, nullable: true })
  tokensUsed?: number | null;

  @ApiProperty({ required: false, nullable: true })
  tokensLimit?: number | null;
}
