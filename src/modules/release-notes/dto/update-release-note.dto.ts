import { PartialType } from '@nestjs/mapped-types'
import { CreateReleaseNoteDto } from './create-release-note.dto'
import { IsBoolean, IsOptional } from 'class-validator'

export class UpdateReleaseNoteDto extends PartialType(CreateReleaseNoteDto) {
  @IsOptional()
  @IsBoolean()
  resetSeen?: boolean
}
