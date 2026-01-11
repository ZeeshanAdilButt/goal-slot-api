import { Controller, Get, Query, UseGuards, Request, Post, Body, Res, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiBody } from '@nestjs/swagger';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { 
  ReportFiltersDto, 
  ExportReportDto, 
  ExportFormat,
  DetailedReportResponse,
  SummaryReportResponse,
  DayByTaskReportResponse,
  DayTotalReportResponse,
  ScheduleReportResponse,
} from './dto';

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

  @Get('detailed')
  @ApiOperation({ 
    summary: 'Get detailed time report with every entry',
    description: 'Returns a detailed report showing every time entry with timestamps, similar to a spreadsheet. Includes daily totals. Perfect for invoicing, mentor reports, and student assignment updates.'
  })
  async getDetailedReport(
    @Request() req: any,
    @Query() filters: ReportFiltersDto,
  ): Promise<DetailedReportResponse> {
    return this.reportsService.getDetailedReport(req.user.sub, filters);
  }

  @Get('summary')
  @ApiOperation({ 
    summary: 'Get summary report grouped by goal/task',
    description: 'Returns a compact summary view showing total accumulated hours by goal, task, category, or date. No individual timestamps shown.'
  })
  async getSummaryReport(
    @Request() req: any,
    @Query() filters: ReportFiltersDto,
  ): Promise<SummaryReportResponse> {
    return this.reportsService.getSummaryReport(req.user.sub, filters);
  }

  @Get('day-by-task')
  @ApiOperation({ 
    summary: 'Get report grouped by day and task',
    description: 'Returns report showing aggregated hours per task per day.'
  })
  async getDayByTaskReport(
    @Request() req: any,
    @Query() filters: ReportFiltersDto,
  ): Promise<DayByTaskReportResponse> {
    return this.reportsService.getDayByTaskReport(req.user.sub, filters);
  }

  @Get('day-total')
  @ApiOperation({ 
    summary: 'Get report grouped by day total',
    description: 'Returns report showing total hours per day with merged task names.'
  })
  async getDayTotalReport(
    @Request() req: any,
    @Query() filters: ReportFiltersDto,
  ): Promise<DayTotalReportResponse> {
    return this.reportsService.getDayTotalReport(req.user.sub, filters);
  }

  @Get('schedule')
  @ApiOperation({ 
    summary: 'Get schedule-based report',
    description: 'Returns report showing hours logged per schedule block, with day-by-day breakdown. Shows how well you stuck to your schedule.'
  })
  async getScheduleReport(
    @Request() req: any,
    @Query() filters: ReportFiltersDto,
  ): Promise<ScheduleReportResponse> {
    return this.reportsService.getScheduleReport(req.user.sub, filters);
  }

  @Get('filterable-goals')
  @ApiOperation({ summary: 'Get list of goals available for filtering' })
  async getFilterableGoals(@Request() req: any) {
    return this.reportsService.getFilterableGoals(req.user.sub);
  }

  @Get('filterable-tasks')
  @ApiOperation({ summary: 'Get list of tasks available for filtering' })
  @ApiQuery({ name: 'goalId', required: false, description: 'Filter tasks by goal ID' })
  async getFilterableTasks(
    @Request() req: any,
    @Query('goalId') goalId?: string,
  ) {
    return this.reportsService.getFilterableTasks(req.user.sub, goalId);
  }

  @Post('export')
  @ApiOperation({ 
    summary: 'Export report in various formats',
    description: 'Generate downloadable report in CSV, PDF, or JSON format. Supports detailed and summary views with customizable filters, billable hours calculations, and client/project information for invoicing.'
  })
  @ApiBody({ type: ExportReportDto })
  async exportReport(
    @Request() req: any,
    @Body() filters: ExportReportDto,
    @Res() res: Response,
  ) {
    const exportData = await this.reportsService.generateExport(req.user.sub, filters);
    
    if (filters.format === ExportFormat.CSV && typeof exportData === 'string') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="time-report-${filters.startDate}-to-${filters.endDate}.csv"`);
      return res.send(exportData);
    }
    
    return res.json(exportData);
  }
}
