import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChatMessageDto {
  @ApiProperty({
    description: 'User-authored chat content. Must be 1-12000 chars.',
    minLength: 1,
    maxLength: 12000,
  })
  @IsString()
  @MinLength(1)
  // Generous cap: users paste whole weekly schedules into the Coach to have it
  // build them. The old 2000-char limit rejected those pastes with a 400, and
  // the UI's error path dropped the just-sent bubble, so the message appeared
  // to vanish. 12000 chars (~3k tokens) fits a detailed full week with room.
  @MaxLength(12000)
  content!: string;
}
