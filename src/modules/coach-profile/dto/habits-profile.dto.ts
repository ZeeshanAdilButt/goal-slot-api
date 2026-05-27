import { ApiProperty } from '@nestjs/swagger';

export class HabitsProfileDto {
  @ApiProperty({ required: false })
  id?: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  why!: string;

  @ApiProperty()
  phoneBlockerInstalled!: boolean;

  @ApiProperty()
  distractingSubsCancelled!: boolean;

  @ApiProperty()
  websiteBlockerUrls!: string;

  @ApiProperty()
  sleepTargetHours!: number;

  @ApiProperty()
  bedtime!: string;

  @ApiProperty()
  wakeTime!: string;

  @ApiProperty()
  workEnvironment!: string;

  @ApiProperty()
  additionalContext!: string;

  @ApiProperty({ required: false, nullable: true })
  createdAt?: Date | null;

  @ApiProperty({ required: false, nullable: true })
  updatedAt?: Date | null;
}
