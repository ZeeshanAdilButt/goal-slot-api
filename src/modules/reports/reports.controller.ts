import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('reports')
@Controller('reports')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard statistics' })
  async getDashboardStats(@Request() req: any) {
    return this.reportsService.getDashboardStats(req.user.sub);
  }

  @Get('weekly')
  @ApiOperation({ summary: 'Get weekly report' })
  @ApiQuery({ name: 'weekStart', required: false, example: '2025-12-01' })
  async getWeeklyReport(@Request() req: any, @Query('weekStart') weekStart?: string) {
    return this.reportsService.getWeeklyReport(req.user.sub, weekStart);
  }

  @Get('goals-progress')
  @ApiOperation({ summary: 'Get all goals progress' })
  async getGoalsProgress(@Request() req: any) {
    return this.reportsService.getGoalProgress(req.user.sub);
  }

  @Get('goal-progress')
  @ApiOperation({ summary: 'Get all goals progress (alias)' })
  async getGoalProgress(@Request() req: any) {
    return this.reportsService.getGoalProgress(req.user.sub);
  }

  @Get('weekly-summary')
  @ApiOperation({ summary: 'Get weekly summary with offset' })
  @ApiQuery({ name: 'weekOffset', required: false, example: 0 })
  async getWeeklySummary(@Request() req: any, @Query('weekOffset') weekOffset?: number) {
    const offset = weekOffset || 0;
    const weekStart = this.getWeekStartWithOffset(offset);
    return this.reportsService.getWeeklySummary(req.user.sub, weekStart);
  }

  private getWeekStartWithOffset(offset: number): string {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) + offset * 7);
    start.setHours(0, 0, 0, 0);
    return start.toISOString().split('T')[0];
  }

  @Get('monthly')
  @ApiOperation({ summary: 'Get monthly report' })
  @ApiQuery({ name: 'year', required: true, example: 2025 })
  @ApiQuery({ name: 'month', required: true, example: 12 })
  async getMonthlyReport(
    @Request() req: any,
    @Query('year') year: number,
    @Query('month') month: number,
  ) {
    return this.reportsService.getMonthlyReport(req.user.sub, year, month);
  }
}
