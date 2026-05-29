import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';

export class UpdateJournalMoodDto {
  @ApiProperty({ nullable: true, minimum: 1, maximum: 5 })
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(5)
  mood!: number | null;

  @ApiProperty({ nullable: true, minimum: 1, maximum: 5 })
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(5)
  energy!: number | null;
}
