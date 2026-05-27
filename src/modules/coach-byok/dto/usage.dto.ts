import { ApiProperty } from '@nestjs/swagger';

export class UsageDto {
  @ApiProperty()
  tokensUsed!: number;

  @ApiProperty()
  tokensLimit!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  windowStart!: Date;
}
