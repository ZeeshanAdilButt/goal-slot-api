import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class OpenConversationDto {
  @ApiProperty({
    description: 'GoalSlot user id of the person to open a conversation with',
    example: '9f1b2c3d-4e5f-6789-abcd-ef0123456789',
  })
  // Deliberately not @IsUUID: ids are uuid-shaped today, but the id
  // column is a plain String and this endpoint has no reason to be the
  // thing that breaks if that ever stops being true. An unknown id is
  // already a clean 404.
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;
}
