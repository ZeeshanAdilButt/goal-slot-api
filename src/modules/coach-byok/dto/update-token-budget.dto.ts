import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/**
 * The monthly token cap the user wants to honor for their BYOK key. This is
 * a soft ceiling enforced server-side: when usage in the current window hits
 * the limit, Coach requests fail with 429 so the user controls spend on
 * their own provider account.
 */
export class UpdateTokenBudgetDto {
  @ApiProperty({
    description:
      'Monthly token cap. Minimum 1,000 to avoid accidentally bricking the Coach; maximum 100,000,000 as a sanity ceiling.',
    minimum: 1_000,
    maximum: 100_000_000,
    example: 250_000,
  })
  @IsInt()
  @Min(1_000)
  @Max(100_000_000)
  tokensLimit!: number;
}
