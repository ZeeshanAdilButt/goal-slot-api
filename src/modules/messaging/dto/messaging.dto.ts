import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

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

export class CanCreateConversationDto {
  @ApiProperty({
    description:
      'GoalSlot user id of the caller jiffy-messaging is authorizing',
    example: '9f1b2c3d-4e5f-6789-abcd-ef0123456789',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  requesterId: string;

  @ApiProperty({
    description:
      'Every participant jiffy-messaging would put in the conversation, including requesterId',
    example: [
      '9f1b2c3d-4e5f-6789-abcd-ef0123456789',
      'a1b2c3d4-5e6f-7890-abcd-ef0123456789',
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  participantIds: string[];
}

/**
 * Body of jiffy-messaging's MessageNotifier callback — POST
 * /internal/messaging/on-message-sent, fired after a message is sent so
 * this API can dispatch its own push/email notification to the
 * recipients. See HttpMessageNotifier in jiffy-messaging for the sender
 * side of this exact shape.
 */
export class OnMessageSentDto {
  @ApiProperty({ description: 'jiffy-messaging message id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  messageId: string;

  @ApiProperty({ description: 'jiffy-messaging conversation id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  conversationId: string;

  @ApiProperty({ description: 'GoalSlot user id of whoever sent the message' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  senderId: string;

  @ApiProperty({
    description:
      'GoalSlot user ids to notify — every other participant, already excluding the sender',
    example: ['a1b2c3d4-5e6f-7890-abcd-ef0123456789'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  recipientIds: string[];

  @ApiProperty({
    description: 'The message text, for the notification preview',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body: string;

  @ApiProperty({ description: 'ISO 8601 timestamp the message was sent' })
  @IsISO8601()
  createdAt: string;
}
