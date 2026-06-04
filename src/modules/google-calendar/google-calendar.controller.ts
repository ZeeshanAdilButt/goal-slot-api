import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SaveSelectionsDto } from './dto/google-calendar.dto';
import { GoogleCalendarService } from './services/google-calendar.service';

@ApiTags('integrations')
@Controller('integrations/google')
export class GoogleCalendarController {
  constructor(private readonly googleCalendar: GoogleCalendarService) {}

  @Get('connect')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the Google OAuth consent URL' })
  connect(@Request() req: any) {
    return { url: this.googleCalendar.getConsentUrl(req.user.sub) };
  }

  // No JwtAuthGuard: Google redirects the bare browser here with no auth
  // header. Identity is recovered from the signed `state` JWT instead.
  @Get('callback')
  @ApiOperation({ summary: 'OAuth callback — redirects back to the web app' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const redirectUrl = await this.googleCalendar.handleCallback(code, state);
    res.redirect(redirectUrl);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Google Calendar connection status' })
  status(@Request() req: any) {
    return this.googleCalendar.getConnectionStatus(req.user.sub);
  }

  @Get('calendars')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the user's Google calendars (picker)" })
  listCalendars(@Request() req: any) {
    return this.googleCalendar.listCalendars(req.user.sub);
  }

  @Put('selections')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save the chosen calendars + sync directions' })
  saveSelections(@Request() req: any, @Body() dto: SaveSelectionsDto) {
    return this.googleCalendar.saveSelections(req.user.sub, dto);
  }

  @Post('sync')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manually trigger a sync' })
  sync(@Request() req: any) {
    return this.googleCalendar.triggerSync(req.user.sub);
  }

  @Delete()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect Google Calendar (revoke + cascade delete)' })
  disconnect(@Request() req: any) {
    return this.googleCalendar.disconnect(req.user.sub);
  }

  @Get('events')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'External events for a visible window' })
  getEvents(@Request() req: any, @Query('from') from: string, @Query('to') to: string) {
    return this.googleCalendar.getEvents(req.user.sub, from, to);
  }
}
