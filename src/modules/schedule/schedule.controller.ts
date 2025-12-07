import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import { CreateScheduleBlockDto, UpdateScheduleBlockDto } from './dto/schedule.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('schedule')
@Controller('schedule')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ScheduleController {
  constructor(private scheduleService: ScheduleService) {}

  @Post()
  @ApiOperation({ summary: 'Create a schedule block' })
  async create(@Request() req: any, @Body() dto: CreateScheduleBlockDto) {
    return this.scheduleService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all schedule blocks' })
  async findAll(@Request() req: any) {
    return this.scheduleService.findAll(req.user.sub);
  }

  @Get('week')
  @ApiOperation({ summary: 'Get weekly schedule grouped by day' })
  async getWeeklySchedule(@Request() req: any) {
    return this.scheduleService.getWeeklySchedule(req.user.sub);
  }

  @Get('day/:dayOfWeek')
  @ApiOperation({ summary: 'Get schedule blocks for a specific day' })
  async findByDay(@Request() req: any, @Param('dayOfWeek') dayOfWeek: number) {
    return this.scheduleService.findByDay(req.user.sub, dayOfWeek);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a schedule block' })
  async update(@Request() req: any, @Param('id') id: string, @Body() dto: UpdateScheduleBlockDto) {
    return this.scheduleService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a schedule block' })
  async delete(@Request() req: any, @Param('id') id: string) {
    return this.scheduleService.delete(req.user.sub, id);
  }
}
