import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsDateString, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';

export enum ReportViewType {
  DETAILED = 'detailed',
  SUMMARY = 'summary',
  DAY_BY_TASK = 'day_by_task',
  DAY_TOTAL = 'day_total',
}

export enum ReportGroupBy {
  GOAL = 'goal',
  TASK = 'task',
  DATE = 'date',
  CATEGORY = 'category',
}

export enum ReportSortBy {
  DATE_ASC = 'date_asc',
  DATE_DESC = 'date_desc',
  DURATION_ASC = 'duration_asc',
  DURATION_DESC = 'duration_desc',
  GOAL = 'goal',
  TASK = 'task',
}

export enum ExportFormat {
  CSV = 'csv',
  PDF = 'pdf',
  JSON = 'json',
}

export class ReportFiltersDto {
  @ApiProperty({ description: 'Start date for the report', example: '2026-01-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date for the report', example: '2026-01-31' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({ enum: ReportViewType, description: 'View type: detailed or summary' })
  @IsOptional()
  @IsEnum(ReportViewType)
  viewType?: ReportViewType;

  @ApiPropertyOptional({ enum: ReportGroupBy, description: 'Group by field for summary view' })
  @IsOptional()
  @IsEnum(ReportGroupBy)
  groupBy?: ReportGroupBy;

  @ApiPropertyOptional({ description: 'Filter by specific goal IDs (comma-separated)' })
  @IsOptional()
  @IsString()
  goalIds?: string;

  @ApiPropertyOptional({ description: 'Filter by specific task IDs (comma-separated)' })
  @IsOptional()
  @IsString()
  taskIds?: string;

  @ApiPropertyOptional({ description: 'Filter by category' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: ReportSortBy, description: 'Sort order for entries' })
  @IsOptional()
  @IsEnum(ReportSortBy)
  sortBy?: ReportSortBy;

  @ApiPropertyOptional({ description: 'Include billable information for invoicing' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeBillable?: boolean;

  @ApiPropertyOptional({ description: 'Hourly rate for invoice calculations' })
  @IsOptional()
  @Transform(({ value }) => parseFloat(value))
  hourlyRate?: number;

  @ApiPropertyOptional({ description: 'Show schedule block context for entries' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  showScheduleContext?: boolean;

  @ApiPropertyOptional({ description: 'Include task notes in report output' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeTaskNotes?: boolean;
}

export class ExportReportDto extends ReportFiltersDto {
  @ApiProperty({ enum: ExportFormat, description: 'Export format' })
  @IsEnum(ExportFormat)
  format: ExportFormat;

  @ApiPropertyOptional({ description: 'Report title for exports' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Include header/footer with client info' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeClientInfo?: boolean;

  @ApiPropertyOptional({ description: 'Client/recipient name' })
  @IsOptional()
  @IsString()
  clientName?: string;

  @ApiPropertyOptional({ description: 'Project name' })
  @IsOptional()
  @IsString()
  projectName?: string;

  @ApiPropertyOptional({ description: 'Additional notes for the report' })
  @IsOptional()
  @IsString()
  notes?: string;
}

// Response types for detailed and summary reports
export interface DetailedTimeEntry {
  id: string;
  date: string;
  dayOfWeek: string;
  startedAt: string | null;
  endedAt: string | null;
  taskName: string;
  duration: number;
  durationFormatted: string;
  notes: string | null;
  goal: { id: string; title: string; color: string } | null;
  task: { id: string; title: string } | null;
  category: string | null;
  scheduleBlock?: {
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    color?: string;
  } | null;
}

export interface DailyBreakdown {
  date: string;
  dayOfWeek: string;
  entries: DetailedTimeEntry[];
  totalMinutes: number;
  totalFormatted: string;
}

export interface SummaryItem {
  id: string;
  name: string;
  color?: string;
  totalMinutes: number;
  totalFormatted: string;
  totalHours: number;
  percentage: number;
  entriesCount: number;
  billableAmount?: number;
}

export interface BillableInfo {
  hourlyRate: number;
  totalHours: number;
  totalAmount: number;
  currency: string;
}

export interface ReportSummary {
  totalMinutes: number;
  totalFormatted: string;
  totalHours: number;
  totalEntries: number;
  daysWithEntries?: number;
  uniqueDays?: number;
  avgMinutesPerDay?: number;
}

export interface DetailedReportResponse {
  reportType: 'detailed';
  startDate: string;
  endDate: string;
  generatedAt: string;
  filters: {
    goalIds?: string[];
    taskIds?: string[];
    category?: string;
  };
  summary: ReportSummary;
  billable: BillableInfo | null;
  dailyBreakdown: DailyBreakdown[];
}

export interface DateBreakdownItem {
  date: string;
  minutes: number;
  formatted: string;
}

export interface SummaryReportResponse {
  reportType: 'summary';
  startDate: string;
  endDate: string;
  generatedAt: string;
  groupBy: ReportGroupBy;
  filters: {
    goalIds?: string[];
    taskIds?: string[];
    category?: string;
  };
  summary: ReportSummary;
  billable: BillableInfo | null;
  items: SummaryItem[];
  dateBreakdown: DateBreakdownItem[];
}

// Report by Day by Task - shows aggregated hours per task per day
export interface DayByTaskEntry {
  taskName: string;
  taskId: string | null;
  goalTitle: string | null;
  goalColor: string | null;
  totalMinutes: number;
  totalFormatted: string;
}

export interface DayByTaskBreakdown {
  date: string;
  dayOfWeek: string;
  tasks: DayByTaskEntry[];
  totalMinutes: number;
  totalFormatted: string;
}

export interface DayByTaskReportResponse {
  reportType: 'day_by_task';
  startDate: string;
  endDate: string;
  generatedAt: string;
  filters: {
    goalIds?: string[];
    taskIds?: string[];
    category?: string;
  };
  summary: ReportSummary;
  billable: BillableInfo | null;
  dailyBreakdown: DayByTaskBreakdown[];
}

// Report by Day - shows total hours per day with tasks grouped by goal
export interface DayTotalGoalGroup {
  goalId: string | null;
  goalTitle: string;
  goalColor: string | null;
  taskNames: string; // Comma-separated unique task names for this goal
  totalMinutes: number;
  totalFormatted: string;
}

export interface DayTotalBreakdown {
  date: string;
  dayOfWeek: string;
  taskNames: string; // Comma-separated unique task names (all goals combined for backward compat)
  goalGroups: DayTotalGoalGroup[]; // Tasks grouped by goal
  totalMinutes: number;
  totalFormatted: string;
  totalHours: number;
}

export interface DayTotalReportResponse {
  reportType: 'day_total';
  startDate: string;
  endDate: string;
  generatedAt: string;
  filters: {
    goalIds?: string[];
    taskIds?: string[];
    category?: string;
  };
  summary: ReportSummary;
  billable: BillableInfo | null;
  dailyBreakdown: DayTotalBreakdown[];
}

// ==========================================
// Schedule-Based Report Types
// ==========================================

export interface SchedulePattern {
  patternKey: string;
  title: string;
  startTime: string;
  endTime: string;
  category?: string;
  color?: string;
  goalTitle?: string;
  goalColor?: string;
  daysOfWeek: number[];
  timeRangeFormatted: string;
}

export interface ScheduleTaskItem {
  taskName: string;
  minutes: number;
  formatted: string;
}

export interface ScheduleDayData {
  date: string;
  dayOfWeek: string;
  dayNumber: number;
  loggedMinutes: number;
  loggedFormatted: string;
  expectedMinutes: number;
  percentage: number;
  tasks: ScheduleTaskItem[];
}

export interface ScheduleReportRow {
  pattern: SchedulePattern;
  days: ScheduleDayData[];
  totalLogged: number;
  totalLoggedFormatted: string;
  totalExpected: number;
  overallPercentage: number;
}

export interface ScheduleReportResponse {
  reportType: 'schedule';
  startDate: string;
  endDate: string;
  generatedAt: string;
  filters: {
    goalIds?: string[];
    taskIds?: string[];
    category?: string;
  };
  summary: {
    totalMinutes: number;
    totalFormatted: string;
    totalExpectedMinutes: number;
    totalExpectedFormatted: string;
    overallPercentage: number;
    totalEntries: number;
    schedulesTracked: number;
  };
  days: Array<{
    date: string;
    dayOfWeek: string;
    dayNumber: number;
  }>;
  rows: ScheduleReportRow[];
}

