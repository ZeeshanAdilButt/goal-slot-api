import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, Min, Max, IsBoolean, Length } from 'class-validator';

export class CreateFeedbackDto {
  @ApiPropertyOptional({ example: 0, description: 'Emoji: 0=love, 1=okay, 2=not great, 3=hate' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(3)
  emoji?: number;

  @ApiPropertyOptional({ example: 'Great product! Love the interface.' })
  @IsOptional()
  @IsString()
  text?: string;
}

export class ArchiveFeedbackDto {
  @ApiProperty({ example: true, description: 'Archive or unarchive the feedback' })
  @IsBoolean()
  isArchived: boolean;
}

export class ReplyFeedbackDto {
  @ApiProperty({ example: 'Thanks for the feedback! Here is our response.' })
  @IsString()
  @Length(1, 2000)
  message: string;
}
