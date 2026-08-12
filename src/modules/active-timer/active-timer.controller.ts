import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveTimerService } from './active-timer.service';
import {
  StartTimerSessionDto,
  StopTimerSessionDto,
  UpdateTimerSessionDto,
} from './dto/active-timer.dto';

/**
 * Singular resource: a user has at most one active timer session, so there is
 * nothing to list and no id in the path. Everything is scoped to the caller.
 */
@ApiTags('active-timer')
@Controller('timer/session')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ActiveTimerController {
  constructor(private readonly activeTimerService: ActiveTimerService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the current active timer session',
    description: 'Returns null (200) when nothing is running, so polling clients need no 404 handling.',
  })
  async getActive(@Request() req: any) {
    return this.activeTimerService.getActive(req.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Start a timer session' })
  @ApiResponse({
    status: 409,
    description:
      'A session is already running. Body carries `code`, `message` and the current `activeSession`. ' +
      'Retry with `takeOver: true` once the user has chosen to replace it.',
  })
  async start(@Request() req: any, @Body() dto: StartTimerSessionDto) {
    return this.activeTimerService.start(req.user.sub, dto);
  }

  @Post('pause')
  @ApiOperation({ summary: 'Pause the running session (idempotent)' })
  async pause(@Request() req: any) {
    return this.activeTimerService.pause(req.user.sub);
  }

  @Post('resume')
  @ApiOperation({ summary: 'Resume the paused session (idempotent)' })
  async resume(@Request() req: any) {
    return this.activeTimerService.resume(req.user.sub);
  }

  @Patch()
  @ApiOperation({
    summary: 'Attach or detach attribution mid-session',
    description:
      'Omitted fields are left alone; fields sent as null are cleared. Does not affect elapsed time.',
  })
  async update(@Request() req: any, @Body() dto: UpdateTimerSessionDto) {
    return this.activeTimerService.updateAttribution(req.user.sub, dto);
  }

  @Post('stop')
  @ApiOperation({
    summary: 'Stop the session and convert it into a time entry',
    description:
      'Atomic: the session row is deleted and the TimeEntry written in one transaction, so a ' +
      'double stop produces exactly one entry.',
  })
  async stop(@Request() req: any, @Body() dto: StopTimerSessionDto) {
    return this.activeTimerService.stop(req.user.sub, dto);
  }

  @Delete()
  @ApiOperation({
    summary: 'Discard the session without logging time',
    description: 'For accidental starts. Writes no TimeEntry.',
  })
  async discard(@Request() req: any) {
    return this.activeTimerService.discard(req.user.sub);
  }
}
