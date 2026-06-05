import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class ImportTemplateDto {
  @ApiProperty({
    description:
      'Import the schedule blocks defined in the template into the user account.',
  })
  @IsBoolean()
  schedule: boolean;

  @ApiProperty({
    description:
      "Create the implicit goals the template's schedule and tasks reference. Required if you want imported schedule blocks and tasks to be linked.",
  })
  @IsBoolean()
  goals: boolean;

  @ApiProperty({
    description:
      'Create the starter tasks defined in the template. If `goals` is false, the tasks land unlinked.',
  })
  @IsBoolean()
  tasks: boolean;

  @ApiPropertyOptional({
    description:
      "Delete the user's existing schedule blocks / goals / tasks first for whichever sections are being imported. Used to retry an import cleanly without leftover data from a previous run.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  replaceExisting?: boolean;
}
