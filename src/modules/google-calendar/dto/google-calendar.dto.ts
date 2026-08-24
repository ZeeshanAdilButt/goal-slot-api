import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Google's own limit is 250 calendars per account, but a preview that fans out
 * across dozens of calendars is both slow and unreviewable. Ten is more than
 * anyone selects in one pass.
 */
const MAX_CALENDARS_PER_PREVIEW = 10;

/**
 * One import request maps 1:1 onto that many ScheduleService.create calls,
 * each of which runs a serializable conflict-guard transaction. Capping the
 * batch keeps a single request from holding the database busy for minutes.
 */
const MAX_EVENTS_PER_IMPORT = 200;

export class PreviewEventsQueryDto {
  @ApiProperty({
    description: 'Comma-separated Google calendar ids to preview',
    example: 'primary,work@group.calendar.google.com',
  })
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CALENDARS_PER_PREVIEW)
  @IsString({ each: true })
  calendarIds: string[];

  @ApiProperty({ description: 'Window start (ISO 8601)' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'Window end (ISO 8601)' })
  @IsISO8601()
  to: string;

  @ApiPropertyOptional({
    description:
      'IANA timezone the week should be interpreted in. Sent by the browser; falls back to UTC when absent or unrecognised, since the day column and time of an imported block depend on it.',
    example: 'Asia/Karachi',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timeZone?: string;
}

/**
 * The review screen sends back the candidates the user ticked, including any
 * edits they made to the title, slot or category — the whole point of the
 * review step is that the projection is adjustable before it is committed.
 *
 * Times are re-validated here with the same `HH:mm` pattern
 * CreateScheduleBlockDto enforces, so an edited value cannot reach
 * ScheduleService in a shape it would have to reject.
 */
export class ImportEventDto {
  @ApiProperty({ description: 'Google event id, used to avoid re-importing' })
  @IsString()
  @MaxLength(1024)
  externalEventId: string;

  @ApiProperty({ description: 'Google calendar id the event came from' })
  @IsString()
  @MaxLength(1024)
  externalCalId: string;

  @ApiProperty({ example: 'Standup' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: 1, description: '0=Sunday .. 6=Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: '09:00' })
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'Start time must be in HH:mm format',
  })
  startTime: string;

  @ApiProperty({ example: '09:30' })
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'End time must be in HH:mm format',
  })
  endTime: string;

  @ApiPropertyOptional({ example: 'MEETING' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ example: '#8B5CF6' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  color?: string;
}

export class ImportEventsDto {
  @ApiProperty({ type: [ImportEventDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENTS_PER_IMPORT)
  @ValidateNested({ each: true })
  @Type(() => ImportEventDto)
  events: ImportEventDto[];
}
