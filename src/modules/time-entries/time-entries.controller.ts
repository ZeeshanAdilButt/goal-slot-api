import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TimeEntriesService } from './time-entries.service';
import { CreateTimeEntryDto, UpdateTimeEntryDto } from './dto/time-entries.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('time-entries')
@Controller('time-entries')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TimeEntriesController {
  constructor(private timeEntriesService: TimeEntriesService) {}

  @Post()
  @ApiOperation({ summary: 'Log a new time entry' })
  async create(@Request() req: any, @Body() dto: CreateTimeEntryDto) {
    return this.timeEntriesService.create(req.user.sub, dto);
  }

  @Get('week')
  @ApiOperation({ summary: 'Get time entries for a week' })
  @ApiQuery({ name: 'weekStart', required: true, example: '2025-12-01' })
  async findByWeek(@Request() req: any, @Query('weekStart') weekStart: string) {
    return this.timeEntriesService.findByWeek(req.user.sub, weekStart);
  }

  @Get('range')
  @ApiOperation({ summary: 'Get time entries by date range' })
  async findByDateRange(
    @Request() req: any,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.timeEntriesService.findByDateRange(req.user.sub, startDate, endDate);
  }

  @Get('today')
  @ApiOperation({ summary: 'Get today\'s total' })
  async getTodayTotal(@Request() req: any) {
    return this.timeEntriesService.getTodayTotal(req.user.sub);
  }

  @Get('weekly-total')
  @ApiOperation({ summary: 'Get this week\'s total' })
  async getWeeklyTotal(@Request() req: any) {
    return this.timeEntriesService.getWeeklyTotal(req.user.sub);
  }

  @Get('recent')
  @ApiOperation({ summary: 'Get recent time entries' })
  async getRecent(
    @Request() req: any,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : undefined;
    const pageSizeNum = pageSize ? parseInt(pageSize, 10) : undefined;
    return this.timeEntriesService.getRecentEntries(req.user.sub, {
      page: pageNum,
      pageSize: pageSizeNum,
      startDate,
      endDate,
    });
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a time entry' })
  async update(@Request() req: any, @Param('id') id: string, @Body() dto: UpdateTimeEntryDto) {
    return this.timeEntriesService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a time entry' })
  async delete(@Request() req: any, @Param('id') id: string) {
    return this.timeEntriesService.delete(req.user.sub, id);
  }
}
