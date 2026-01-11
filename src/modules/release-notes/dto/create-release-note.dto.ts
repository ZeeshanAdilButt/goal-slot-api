import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator'

export class CreateReleaseNoteDto {
  @IsString()
  @MaxLength(50)
  version: string

  @IsString()
  @MaxLength(200)
  title: string

  @IsString()
  content: string

  @IsOptional()
  @IsDateString()
  publishedAt?: string
}
