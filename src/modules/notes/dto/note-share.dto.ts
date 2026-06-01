import { IsEmail } from 'class-validator';

export class InviteNoteShareDto {
  @IsEmail()
  email: string;
}
