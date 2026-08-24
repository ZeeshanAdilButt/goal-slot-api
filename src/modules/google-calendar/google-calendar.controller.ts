import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ImportEventsDto,
  PreviewEventsQueryDto,
} from './dto/google-calendar.dto';
import { GoogleCalendarService } from './services/google-calendar.service';

interface AuthedRequest {
  user: { sub: string };
}

/**
 * Google Calendar import.
 *
 * The flow is deliberately three steps — connect, preview, import — rather
 * than a single "sync" button. Importing writes real ScheduleBlocks into the
 * user's weekly grid, and a Google calendar routinely contains things nobody
 * wants there (declined invites, a partner's shared calendar, birthdays). The
 * preview step exists so the user decides, event by event, what becomes part
 * of their schedule.
 */
@ApiTags('integrations')
@Controller('integrations/google-calendar')
export class GoogleCalendarController {
  constructor(private readonly googleCalendar: GoogleCalendarService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Google Calendar connection status' })
  status(@Req() req: AuthedRequest) {
    return this.googleCalendar.getConnectionStatus(req.user.sub);
  }

  @Get('connect')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the Google consent URL' })
  connect(@Req() req: AuthedRequest) {
    return { url: this.googleCalendar.getConsentUrl(req.user.sub) };
  }

  /**
   * Unguarded on purpose: Google redirects the browser here with no
   * Authorization header. Identity comes from the signed `state` JWT, which
   * the service verifies (including its `purpose` claim) before touching
   * anything.
   */
  @Get('callback')
  @ApiOperation({ summary: 'OAuth callback; redirects back to the web app' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    res.redirect(await this.googleCalendar.handleCallback(code, state, error));
  }

  @Get('calendars')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the connected account's calendars" })
  listCalendars(@Req() req: AuthedRequest) {
    return this.googleCalendar.listCalendars(req.user.sub);
  }

  /**
   * The review step. Reads live from Google and returns what *would* be
   * created — day column, time, occurrence count, plus whether each row was
   * already imported or would collide with an existing block. Creates nothing.
   */
  @Get('preview')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Preview importable events for review' })
  preview(@Req() req: AuthedRequest, @Query() query: PreviewEventsQueryDto) {
    return this.googleCalendar.previewEvents(req.user.sub, query);
  }

  /** Creates blocks for the reviewed selection only. */
  @Post('import')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Import the selected events as schedule blocks' })
  import(@Req() req: AuthedRequest, @Body() dto: ImportEventsDto) {
    return this.googleCalendar.importEvents(req.user.sub, dto);
  }

  @Delete()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect Google Calendar' })
  disconnect(@Req() req: AuthedRequest) {
    return this.googleCalendar.disconnect(req.user.sub);
  }
}
