import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import {
  CreateScheduleBlockDto,
  CreateScheduleBlocksBatchDto,
  UpdateScheduleBlockDto,
} from './dto/schedule.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';

@ApiTags('schedule')
@Controller('schedule')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ScheduleController {
  constructor(private scheduleService: ScheduleService) {}

  @Post()
  @ApiOperation({ summary: 'Create a schedule block' })
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateScheduleBlockDto,
  ) {
    return this.scheduleService.create(req.user.sub, dto);
  }

  // Atomic multi-day create: e.g. the "New Block" modal's day picker, where
  // several per-day payloads share one seriesId and must succeed or fail
  // together. See ScheduleService.createBatch — kept as an ADDITIVE endpoint
  // alongside the single-block POST above (untouched, still used standalone
  // by e.g. the Coach proposal path), not a replacement for it.
  @Post('batch')
  @ApiOperation({
    summary:
      'Create a group of schedule blocks atomically (all-or-nothing) — used for multi-day creates',
  })
  async createBatch(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateScheduleBlocksBatchDto,
  ) {
    return this.scheduleService.createBatch(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all schedule blocks' })
  async findAll(@Request() req: AuthenticatedRequest) {
    return this.scheduleService.findAll(req.user.sub);
  }

  @Get('week')
  @ApiOperation({ summary: 'Get weekly schedule grouped by day' })
  async getWeeklySchedule(@Request() req: AuthenticatedRequest) {
    return this.scheduleService.getWeeklySchedule(req.user.sub);
  }

  @Get('day/:dayOfWeek')
  @ApiOperation({ summary: 'Get schedule blocks for a specific day' })
  async findByDay(
    @Request() req: AuthenticatedRequest,
    @Param('dayOfWeek') dayOfWeek: number,
  ) {
    return this.scheduleService.findByDay(req.user.sub, dayOfWeek);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a schedule block' })
  async update(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateScheduleBlockDto,
  ) {
    return this.scheduleService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a schedule block' })
  async delete(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.scheduleService.delete(req.user.sub, id);
  }

  // Wipe every schedule block for the calling user. Used by the "Clear all"
  // action on the schedule page, gated client-side by a typed-confirm modal.
  // Time entries linked via scheduleBlockId have onDelete: SetNull on the
  // relation, so this does not delete tracked time; it just unlinks it.
  @Delete()
  @ApiOperation({ summary: 'Delete ALL schedule blocks for the current user' })
  async clearAll(@Request() req: AuthenticatedRequest) {
    return this.scheduleService.clearAll(req.user.sub);
  }
}
