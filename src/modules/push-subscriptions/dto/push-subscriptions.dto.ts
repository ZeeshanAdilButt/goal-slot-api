import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// A subscription is either a web push registration (endpoint + keys) or an
// Expo push token — never both, never neither. The DTO stays permissive
// (everything optional) so the shape check can live in the service and
// produce one clear error message instead of class-validator's generic one.
export class RegisterPushSubscriptionDto {
  @ApiProperty({ required: false, description: 'Web push subscription endpoint URL' })
  @IsOptional()
  @IsString()
  endpoint?: string;

  @ApiProperty({ required: false, description: 'Web push p256dh key' })
  @IsOptional()
  @IsString()
  p256dh?: string;

  @ApiProperty({ required: false, description: 'Web push auth secret' })
  @IsOptional()
  @IsString()
  auth?: string;

  @ApiProperty({ required: false, description: 'Expo push token' })
  @IsOptional()
  @IsString()
  expoToken?: string;
}
