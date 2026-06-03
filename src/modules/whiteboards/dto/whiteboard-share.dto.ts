import { IsEmail } from 'class-validator';

export class InviteWhiteboardShareDto {
  @IsEmail()
  email: string;
}