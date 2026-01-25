import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GoalStatus } from '@prisma/client';
import { 
  ReportFiltersDto, 
  ReportViewType, 
  ReportGroupBy, 
  ReportSortBy, 
  ExportReportDto, 
  ExportFormat,
  DetailedTimeEntry,
  DailyBreakdown,
  SummaryItem,
  DetailedReportResponse,
  SummaryReportResponse,
  DayByTaskReportResponse,
  DayByTaskBreakdown,
  DayByTaskEntry,
  DayTotalReportResponse,
  DayTotalBreakdown,
  ScheduleReportResponse,
  ScheduleReportRow,
  SchedulePattern,
  ScheduleDayData,
} from './dto';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async getDashboardStats(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Week start (Monday)
    const dayOfWeek = today.getDay();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const [todayTotal, weeklyTotal, activeGoals, tasksLogged] = await Promise.all([
      this.prisma.timeEntry.aggregate({
        where: { userId, date: { gte: today, lt: tomorrow } },
        _sum: { duration: true },
      }),
      this.prisma.timeEntry.aggregate({
        where: { userId, date: { gte: weekStart, lte: weekEnd } },
        _sum: { duration: true },
      }),
      this.prisma.goal.count({ where: { userId, status: GoalStatus.ACTIVE } }),
      this.prisma.timeEntry.count({ where: { userId, date: { gte: today, lt: tomorrow } } }),
    ]);

    return {
      todayMinutes: todayTotal._sum.duration || 0,
      todayFormatted: this.formatDuration(todayTotal._sum.duration || 0),
      weeklyMinutes: weeklyTotal._sum.duration || 0,
      weeklyFormatted: this.formatDuration(weeklyTotal._sum.duration || 0),
      activeGoals,
      tasksLogged,
    };
  }

  async getWeeklyReport(userId: string, weekStart?: string) {
    const start = weekStart ? new Date(weekStart) : this.getWeekStart(new Date());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
      },
      include: {
        goal: { select: { id: true, title: true, color: true } },
      },
    });

    // Daily activity
    const dailyActivity: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const goalBreakdown: Record<string, { title: string; color: string; minutes: number }> = {};
    let totalMinutes = 0;

    entries.forEach((entry) => {
      dailyActivity[entry.dayOfWeek] += entry.duration;
      totalMinutes += entry.duration;

      if (entry.goal) {
        if (!goalBreakdown[entry.goal.id]) {
          goalBreakdown[entry.goal.id] = {
            title: entry.goal.title,
            color: entry.goal.color,
            minutes: 0,
          };
        }
        goalBreakdown[entry.goal.id].minutes += entry.duration;
      } else {
        if (!goalBreakdown['other']) {
          goalBreakdown['other'] = { title: 'Other', color: '#94A3B8', minutes: 0 };
        }
        goalBreakdown['other'].minutes += entry.duration;
      }
    });

    // Top activities
    const topActivities = entries
      .reduce((acc: any[], entry) => {
        const existing = acc.find((a) => a.taskName === entry.taskName);
        if (existing) {
          existing.duration += entry.duration;
        } else {
          acc.push({
            taskName: entry.taskName,
            duration: entry.duration,
            goalTitle: entry.goal?.title || 'Other',
            goalColor: entry.goal?.color || '#94A3B8',
          });
        }
        return acc;
      }, [])
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5);

    const daysWithEntries = Object.values(dailyActivity).filter((d) => d > 0).length;

    return {
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
      totalMinutes,
      totalFormatted: this.formatDuration(totalMinutes),
      dailyAverage: daysWithEntries > 0 ? Math.round(totalMinutes / daysWithEntries) : 0,
      dailyAverageFormatted: this.formatDuration(daysWithEntries > 0 ? Math.round(totalMinutes / daysWithEntries) : 0),
      tasksLogged: entries.length,
      dailyActivity: Object.entries(dailyActivity).map(([day, minutes]) => ({
        day: Number(day),
        dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(day)],
        minutes,
        formatted: this.formatDuration(minutes),
      })),
      goalBreakdown: Object.entries(goalBreakdown).map(([id, data]) => ({
        goalId: id,
        ...data,
        percentage: totalMinutes > 0 ? Math.round((data.minutes / totalMinutes) * 100) : 0,
        formatted: this.formatDuration(data.minutes),
      })),
      topActivities: topActivities.map((a, i) => ({
        rank: i + 1,
        ...a,
        formatted: this.formatDuration(a.duration),
      })),
    };
  }

  async getWeeklySummary(userId: string, weekStart: string) {
    const start = new Date(weekStart);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
      },
      include: {
        goal: { select: { id: true, title: true, category: true } },
      },
    });

    const totalMinutes = entries.reduce((sum, e) => sum + e.duration, 0);
    const daysData = [0, 1, 2, 3, 4, 5, 6].map(dayIdx => {
      const dayDate = new Date(start);
      dayDate.setDate(start.getDate() + dayIdx);
      const dayEntries = entries.filter(e => {
        const entryDate = new Date(e.date);
        return entryDate.toDateString() === dayDate.toDateString();
      });
      const totalMins = dayEntries.reduce((s, e) => s + e.duration, 0);
      const categories: Record<string, number> = {};
      dayEntries.forEach(e => {
        const cat = e.goal?.category || 'OTHER';
        categories[cat] = (categories[cat] || 0) + e.duration;
      });
      return {
        date: dayDate.toISOString().split('T')[0],
        totalMinutes: totalMins,
        entriesCount: dayEntries.length,
        categories,
      };
    });

    const byCategory: Record<string, number> = {};
    entries.forEach(e => {
      const cat = e.goal?.category || 'OTHER';
      byCategory[cat] = (byCategory[cat] || 0) + e.duration;
    });

    const byGoal: Array<{ goalId: string; goalTitle: string; minutes: number }> = [];
    const goalMap: Record<string, { goalId: string; goalTitle: string; minutes: number }> = {};
    entries.forEach(e => {
      if (e.goal) {
        if (!goalMap[e.goal.id]) {
          goalMap[e.goal.id] = { goalId: e.goal.id, goalTitle: e.goal.title, minutes: 0 };
        }
        goalMap[e.goal.id].minutes += e.duration;
      }
    });
    Object.values(goalMap).forEach(g => byGoal.push(g));

    const daysWithEntries = daysData.filter(d => d.entriesCount > 0).length;
    let mostProductiveDay = '';
    let maxMinutes = 0;
    daysData.forEach(d => {
      if (d.totalMinutes > maxMinutes) {
        maxMinutes = d.totalMinutes;
        mostProductiveDay = d.date;
      }
    });

    return {
      totalMinutes,
      avgMinutesPerDay: daysWithEntries > 0 ? Math.round(totalMinutes / daysWithEntries) : 0,
      totalEntries: entries.length,
      mostProductiveDay,
      byCategory,
      byGoal,
      dailyBreakdown: daysData,
    };
  }

  async getGoalProgress(userId: string) {
    const goals = await this.prisma.goal.findMany({
      where: { userId, status: GoalStatus.ACTIVE },
      orderBy: { deadline: 'asc' },
    });

    return goals.map((goal) => {
      const progress = goal.targetHours > 0 ? (goal.loggedHours / goal.targetHours) * 100 : 0;
      const daysLeft = goal.deadline
        ? Math.max(0, Math.ceil((goal.deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null;

      return {
        id: goal.id,
        title: goal.title,
        color: goal.color,
        loggedHours: goal.loggedHours,
        targetHours: goal.targetHours,
        progress: Math.min(100, Math.round(progress)),
        deadline: goal.deadline?.toISOString(),
        daysLeft,
        status: daysLeft !== null && daysLeft < 0 ? 'overdue' : progress >= 100 ? 'completed' : 'in-progress',
      };
    });
  }

  async getMonthlyReport(userId: string, year: number, month: number) {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
      },
    });

    const totalMinutes = entries.reduce((sum, e) => sum + e.duration, 0);
    const daysWithEntries = new Set(entries.map((e) => e.date.toDateString())).size;

    return {
      year,
      month,
      totalMinutes,
      totalFormatted: this.formatDuration(totalMinutes),
      totalHours: (totalMinutes / 60).toFixed(1),
      daysActive: daysWithEntries,
      dailyAverage: daysWithEntries > 0 ? Math.round(totalMinutes / daysWithEntries) : 0,
      tasksLogged: entries.length,
    };
  }

  /**
   * Get detailed report - shows every time entry with timestamps
   * Perfect for freelancers/contractors sending invoices, mentees reporting to mentors,
   * and students submitting detailed progress reports
   */
  async getDetailedReport(userId: string, filters: ReportFiltersDto): Promise<DetailedReportResponse> {
    const start = new Date(filters.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);

    const goalIdArray = filters.goalIds ? filters.goalIds.split(',').map(id => id.trim()) : undefined;
    const taskIdArray = filters.taskIds ? filters.taskIds.split(',').map(id => id.trim()) : undefined;

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
        ...(goalIdArray && goalIdArray.length > 0 ? { goalId: { in: goalIdArray } } : {}),
        ...(taskIdArray && taskIdArray.length > 0 ? { taskId: { in: taskIdArray } } : {}),
        ...(filters.category ? { goal: { category: filters.category } } : {}),
      },
      include: {
        goal: { select: { id: true, title: true, color: true, category: true } },
        task: { select: { id: true, title: true, category: true, notes: true } },
        ...(filters.showScheduleContext ? {
          scheduleBlock: { select: { id: true, title: true, startTime: true, endTime: true, color: true } },
        } : {}),
      },
      orderBy: this.getSortOrder(filters.sortBy),
    });

    // Build daily breakdown (like a spreadsheet)
    const dailyMap = new Map<string, DailyBreakdown>();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    let totalMinutes = 0;

    for (const entry of entries) {
      const dateKey = entry.date.toISOString().split('T')[0];
      const dayOfWeek = dayNames[entry.dayOfWeek];
      
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: dateKey,
          dayOfWeek,
          entries: [],
          totalMinutes: 0,
          totalFormatted: '',
        });
      }

      const endedAt = entry.startedAt && entry.duration 
        ? new Date(new Date(entry.startedAt).getTime() + entry.duration * 60000).toISOString()
        : null;

      const detailedEntry: DetailedTimeEntry = {
        id: entry.id,
        date: dateKey,
        dayOfWeek,
        startedAt: entry.startedAt?.toISOString() || null,
        endedAt,
        taskName: entry.taskName,
        duration: entry.duration,
        durationFormatted: this.formatDuration(entry.duration),
        notes: entry.notes,
        taskNotes: filters.includeTaskNotes && entry.task ? entry.task.notes : null,
        goal: entry.goal ? { id: entry.goal.id, title: entry.goal.title, color: entry.goal.color } : null,
        task: entry.task ? { id: entry.task.id, title: entry.task.title } : null,
        category: entry.goal?.category || entry.task?.category || null,
        scheduleBlock: (entry as any).scheduleBlock ? {
          id: (entry as any).scheduleBlock.id,
          title: (entry as any).scheduleBlock.title,
          startTime: (entry as any).scheduleBlock.startTime,
          endTime: (entry as any).scheduleBlock.endTime,
          color: (entry as any).scheduleBlock.color,
        } : null,
      };

      const day = dailyMap.get(dateKey)!;
      day.entries.push(detailedEntry);
      day.totalMinutes += entry.duration;
      totalMinutes += entry.duration;
    }

    // Calculate daily totals
    dailyMap.forEach(day => {
      day.totalFormatted = this.formatDuration(day.totalMinutes);
    });

    const dailyBreakdown = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const totalHours = totalMinutes / 60;

    // Calculate billable info if requested
    let billableInfo = null;
    if (filters.includeBillable && filters.hourlyRate) {
      billableInfo = {
        hourlyRate: filters.hourlyRate,
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalAmount: parseFloat((totalHours * filters.hourlyRate).toFixed(2)),
        currency: 'USD', // Could be made configurable
      };
    }

    return {
      reportType: 'detailed',
      startDate: filters.startDate,
      endDate: filters.endDate,
      generatedAt: new Date().toISOString(),
      filters: {
        goalIds: goalIdArray,
        taskIds: taskIdArray,
        category: filters.category,
      },
      summary: {
        totalMinutes,
        totalFormatted: this.formatDuration(totalMinutes),
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalEntries: entries.length,
        daysWithEntries: dailyBreakdown.length,
        avgMinutesPerDay: dailyBreakdown.length > 0 ? Math.round(totalMinutes / dailyBreakdown.length) : 0,
      },
      billable: billableInfo,
      dailyBreakdown,
    };
  }

  /**
   * Get summary report - compact aggregated view by goal/task
   * Shows total accumulated hours without specific timestamps
   * Perfect for quick overviews and high-level progress reports
   */
  async getSummaryReport(userId: string, filters: ReportFiltersDto): Promise<SummaryReportResponse> {
    const start = new Date(filters.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);

    const goalIdArray = filters.goalIds ? filters.goalIds.split(',').map(id => id.trim()) : undefined;
    const taskIdArray = filters.taskIds ? filters.taskIds.split(',').map(id => id.trim()) : undefined;

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
        ...(goalIdArray && goalIdArray.length > 0 ? { goalId: { in: goalIdArray } } : {}),
        ...(taskIdArray && taskIdArray.length > 0 ? { taskId: { in: taskIdArray } } : {}),
        ...(filters.category ? { goal: { category: filters.category } } : {}),
      },
      include: {
        goal: { select: { id: true, title: true, color: true, category: true } },
        task: { select: { id: true, title: true, category: true, notes: true } },
      },
    });

    let totalMinutes = 0;
    entries.forEach(e => totalMinutes += e.duration);

    const groupBy = filters.groupBy || ReportGroupBy.GOAL;
    const summaryItems = this.aggregateByGroup(entries, groupBy, totalMinutes, filters.hourlyRate);

    // Calculate billable info if requested
    let billableInfo = null;
    const totalHours = totalMinutes / 60;
    if (filters.includeBillable && filters.hourlyRate) {
      billableInfo = {
        hourlyRate: filters.hourlyRate,
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalAmount: parseFloat((totalHours * filters.hourlyRate).toFixed(2)),
        currency: 'USD',
      };
    }

    // Date range breakdown for charts
    const dateBreakdown = this.buildDateBreakdown(entries, start, end);

    return {
      reportType: 'summary',
      startDate: filters.startDate,
      endDate: filters.endDate,
      generatedAt: new Date().toISOString(),
      groupBy,
      filters: {
        goalIds: goalIdArray,
        taskIds: taskIdArray,
        category: filters.category,
      },
      summary: {
        totalMinutes,
        totalFormatted: this.formatDuration(totalMinutes),
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalEntries: entries.length,
        uniqueDays: new Set(entries.map(e => e.date.toISOString().split('T')[0])).size,
      },
      billable: billableInfo,
      items: summaryItems,
      dateBreakdown,
    };
  }

  /**
   * Get Day by Task report - shows aggregated hours per task per day
   * No individual timestamps, just totals per task per day
   */
  async getDayByTaskReport(userId: string, filters: ReportFiltersDto): Promise<DayByTaskReportResponse> {
    const start = new Date(filters.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);

    const goalIdArray = filters.goalIds ? filters.goalIds.split(',').map(id => id.trim()) : undefined;
    const taskIdArray = filters.taskIds ? filters.taskIds.split(',').map(id => id.trim()) : undefined;

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
        ...(goalIdArray && goalIdArray.length > 0 ? { goalId: { in: goalIdArray } } : {}),
        ...(taskIdArray && taskIdArray.length > 0 ? { taskId: { in: taskIdArray } } : {}),
        ...(filters.category ? { goal: { category: filters.category } } : {}),
      },
      include: {
        goal: { select: { id: true, title: true, color: true } },
        task: { select: { id: true, title: true, notes: true } },
      },
      orderBy: [{ date: 'asc' }],
    });

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    // Group entries by date, then by task
    const dailyMap = new Map<string, Map<string, DayByTaskEntry & { dayOfWeek: string }>>();
    let totalMinutes = 0;
    let totalEntries = 0;

    for (const entry of entries) {
      const dateKey = entry.date.toISOString().split('T')[0];
      const dayOfWeek = dayNames[entry.dayOfWeek];
      
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, new Map());
      }
      
      const taskMap = dailyMap.get(dateKey)!;
      // Use taskId or normalized task name as key to aggregate
      const taskKey = entry.taskId || entry.taskName.trim().toLowerCase();
      
      if (!taskMap.has(taskKey)) {
        taskMap.set(taskKey, {
          taskName: entry.task?.title || entry.taskName,
          taskId: entry.taskId,
          goalTitle: entry.goal?.title || null,
          goalColor: entry.goal?.color || null,
          totalMinutes: 0,
          totalFormatted: '',
          dayOfWeek,
        });
      }

      const task = taskMap.get(taskKey)!;
      task.totalMinutes += entry.duration;
      totalMinutes += entry.duration;
      totalEntries++;
    }

    // Convert to array structure
    const dailyBreakdown: DayByTaskBreakdown[] = [];
    for (const [dateKey, taskMap] of dailyMap) {
      const tasks = Array.from(taskMap.values())
        .map(({ dayOfWeek, ...task }) => ({
          ...task,
          totalFormatted: this.formatDuration(task.totalMinutes),
        }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes);

      const dayTotal = tasks.reduce((sum, t) => sum + t.totalMinutes, 0);
      const firstTask = taskMap.values().next().value;

      dailyBreakdown.push({
        date: dateKey,
        dayOfWeek: firstTask?.dayOfWeek || dayNames[new Date(dateKey).getDay()],
        tasks,
        totalMinutes: dayTotal,
        totalFormatted: this.formatDuration(dayTotal),
      });
    }

    // Sort by date
    dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

    const totalHours = totalMinutes / 60;
    let billableInfo = null;
    if (filters.includeBillable && filters.hourlyRate) {
      billableInfo = {
        hourlyRate: filters.hourlyRate,
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalAmount: parseFloat((totalHours * filters.hourlyRate).toFixed(2)),
        currency: 'USD',
      };
    }

    return {
      reportType: 'day_by_task',
      startDate: filters.startDate,
      endDate: filters.endDate,
      generatedAt: new Date().toISOString(),
      filters: {
        goalIds: goalIdArray,
        taskIds: taskIdArray,
        category: filters.category,
      },
      summary: {
        totalMinutes,
        totalFormatted: this.formatDuration(totalMinutes),
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalEntries,
        uniqueDays: dailyBreakdown.length,
      },
      billable: billableInfo,
      dailyBreakdown,
    };
  }

  /**
   * Get Day Total report - shows total hours per day with merged task names
   * Just daily totals with comma-separated task names
   */
  async getDayTotalReport(userId: string, filters: ReportFiltersDto): Promise<DayTotalReportResponse> {
    const start = new Date(filters.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);

    const goalIdArray = filters.goalIds ? filters.goalIds.split(',').map(id => id.trim()) : undefined;
    const taskIdArray = filters.taskIds ? filters.taskIds.split(',').map(id => id.trim()) : undefined;

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
        ...(goalIdArray && goalIdArray.length > 0 ? { goalId: { in: goalIdArray } } : {}),
        ...(taskIdArray && taskIdArray.length > 0 ? { taskId: { in: taskIdArray } } : {}),
        ...(filters.category ? { goal: { category: filters.category } } : {}),
      },
      include: {
        task: { select: { id: true, title: true, notes: true } },
        goal: { select: { id: true, title: true, color: true } },
        scheduleBlock: { select: { id: true, title: true, startTime: true, endTime: true } },
      },
      orderBy: [{ date: 'asc' }],
    });

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    // Group entries by date, then by goal
    interface GoalData {
      goalId: string | null;
      goalTitle: string;
      goalColor: string | null;
      taskNames: Set<string>;
      totalMinutes: number;
    }
    
    interface DayData {
      dayOfWeek: string;
      goalMap: Map<string, GoalData>; // goalId or 'no-goal' -> GoalData
      allTaskNames: Set<string>;
      totalMinutes: number;
    }
    
    const dailyMap = new Map<string, DayData>();
    let totalMinutes = 0;
    let totalEntries = 0;

    for (const entry of entries) {
      const dateKey = entry.date.toISOString().split('T')[0];
      const dayOfWeek = dayNames[entry.dayOfWeek];
      
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          dayOfWeek,
          goalMap: new Map(),
          allTaskNames: new Set(),
          totalMinutes: 0,
        });
      }
      
      const day = dailyMap.get(dateKey)!;
      const taskName = entry.task?.title || entry.taskName;
      const goalKey = entry.goalId || 'no-goal';
      
      if (!day.goalMap.has(goalKey)) {
        day.goalMap.set(goalKey, {
          goalId: entry.goalId,
          goalTitle: entry.goal?.title || 'No Goal',
          goalColor: entry.goal?.color || null,
          taskNames: new Set(),
          totalMinutes: 0,
        });
      }
      
      const goalData = day.goalMap.get(goalKey)!;
      goalData.taskNames.add(taskName);
      goalData.totalMinutes += entry.duration;
      
      day.allTaskNames.add(taskName);
      day.totalMinutes += entry.duration;
      totalMinutes += entry.duration;
      totalEntries++;
    }

    // Convert to array structure with goal groups
    const dailyBreakdown: DayTotalBreakdown[] = Array.from(dailyMap.entries())
      .map(([dateKey, data]) => ({
        date: dateKey,
        dayOfWeek: data.dayOfWeek,
        taskNames: Array.from(data.allTaskNames).join(', '),
        goalGroups: Array.from(data.goalMap.values())
          .map(g => ({
            goalId: g.goalId,
            goalTitle: g.goalTitle,
            goalColor: g.goalColor,
            taskNames: Array.from(g.taskNames).join(', '),
            totalMinutes: g.totalMinutes,
            totalFormatted: this.formatDuration(g.totalMinutes),
          }))
          .sort((a, b) => b.totalMinutes - a.totalMinutes), // Sort by time descending
        totalMinutes: data.totalMinutes,
        totalFormatted: this.formatDuration(data.totalMinutes),
        totalHours: parseFloat((data.totalMinutes / 60).toFixed(2)),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalHours = totalMinutes / 60;
    let billableInfo = null;
    if (filters.includeBillable && filters.hourlyRate) {
      billableInfo = {
        hourlyRate: filters.hourlyRate,
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalAmount: parseFloat((totalHours * filters.hourlyRate).toFixed(2)),
        currency: 'USD',
      };
    }

    return {
      reportType: 'day_total',
      startDate: filters.startDate,
      endDate: filters.endDate,
      generatedAt: new Date().toISOString(),
      filters: {
        goalIds: goalIdArray,
        taskIds: taskIdArray,
        category: filters.category,
      },
      summary: {
        totalMinutes,
        totalFormatted: this.formatDuration(totalMinutes),
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalEntries,
        uniqueDays: dailyBreakdown.length,
      },
      billable: billableInfo,
      dailyBreakdown,
    };
  }

  /**
   * Get schedule-based report showing hours logged per schedule block
   */
  async getScheduleReport(userId: string, filters: ReportFiltersDto): Promise<ScheduleReportResponse> {
    const start = new Date(filters.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);

    const goalIdArray = filters.goalIds ? filters.goalIds.split(',').map(id => id.trim()) : undefined;
    const taskIdArray = filters.taskIds ? filters.taskIds.split(',').map(id => id.trim()) : undefined;

    // Get user's schedule blocks
    const scheduleBlocks = await this.prisma.scheduleBlock.findMany({
      where: { userId },
      include: {
        goal: { select: { id: true, title: true, color: true } },
      },
    });

    // Get time entries in range with schedule block info
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: start, lte: end },
        scheduleBlockId: { not: null },
        ...(goalIdArray && goalIdArray.length > 0 ? { goalId: { in: goalIdArray } } : {}),
        ...(taskIdArray && taskIdArray.length > 0 ? { taskId: { in: taskIdArray } } : {}),
        ...(filters.category ? { goal: { category: filters.category } } : {}),
      },
      include: {
        task: { select: { id: true, title: true } },
        scheduleBlock: {
          select: { id: true, title: true, startTime: true, endTime: true, category: true, color: true, goalId: true },
        },
      },
      orderBy: [{ date: 'asc' }],
    });

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    // Build list of days in range
    const days: Array<{ date: string; dayOfWeek: string; dayNumber: number }> = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      days.push({
        date: cursor.toISOString().split('T')[0],
        dayOfWeek: dayNames[cursor.getDay()],
        dayNumber: cursor.getDay(),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Group schedule blocks by pattern (same title + time range)
    const patternMap = new Map<string, {
      pattern: SchedulePattern;
      blockIds: string[];
      dayDataMap: Map<string, { minutes: number; tasks: Map<string, number> }>;
    }>();

    for (const block of scheduleBlocks) {
      const patternKey = `${block.title}|${block.startTime}-${block.endTime}`;
      
      if (!patternMap.has(patternKey)) {
        // Calculate expected minutes from schedule time range
        const [startH, startM] = block.startTime.split(':').map(Number);
        const [endH, endM] = block.endTime.split(':').map(Number);
        const expectedMinutes = (endH * 60 + endM) - (startH * 60 + startM);

        const goal = block.goal;
        
        patternMap.set(patternKey, {
          pattern: {
            patternKey,
            title: block.title,
            startTime: block.startTime,
            endTime: block.endTime,
            category: block.category ?? undefined,
            color: block.color,
            goalTitle: goal?.title,
            goalColor: goal?.color,
            daysOfWeek: [],
            timeRangeFormatted: this.formatTimeRange(block.startTime, block.endTime),
          },
          blockIds: [],
          dayDataMap: new Map(),
        });
      }

      const patternData = patternMap.get(patternKey)!;
      patternData.blockIds.push(block.id);
      if (!patternData.pattern.daysOfWeek.includes(block.dayOfWeek)) {
        patternData.pattern.daysOfWeek.push(block.dayOfWeek);
      }
    }

    // Aggregate time entries by schedule pattern and day
    let totalEntries = 0;
    for (const entry of entries) {
      if (!entry.scheduleBlock) continue;

      const patternKey = `${entry.scheduleBlock.title}|${entry.scheduleBlock.startTime}-${entry.scheduleBlock.endTime}`;
      const patternData = patternMap.get(patternKey);
      if (!patternData) continue;

      const dateKey = entry.date.toISOString().split('T')[0];
      const taskName = entry.task?.title || entry.taskName;

      if (!patternData.dayDataMap.has(dateKey)) {
        patternData.dayDataMap.set(dateKey, { minutes: 0, tasks: new Map() });
      }

      const dayData = patternData.dayDataMap.get(dateKey)!;
      dayData.minutes += entry.duration;
      dayData.tasks.set(taskName, (dayData.tasks.get(taskName) || 0) + entry.duration);
      totalEntries++;
    }

    // Build report rows
    const rows: ScheduleReportRow[] = [];
    let totalLogged = 0;
    let totalExpected = 0;

    for (const [, patternData] of patternMap) {
      const { pattern, dayDataMap } = patternData;
      
      // Calculate expected minutes for this pattern
      const [startH, startM] = pattern.startTime.split(':').map(Number);
      const [endH, endM] = pattern.endTime.split(':').map(Number);
      const expectedMinutesPerDay = (endH * 60 + endM) - (startH * 60 + startM);

      const rowDays: ScheduleDayData[] = [];
      let rowTotalLogged = 0;
      let rowTotalExpected = 0;

      for (const day of days) {
        const hasSchedule = pattern.daysOfWeek.includes(day.dayNumber);
        const dayData = dayDataMap.get(day.date);
        
        const loggedMinutes = dayData?.minutes || 0;
        const expectedMinutes = hasSchedule ? expectedMinutesPerDay : 0;
        
        rowDays.push({
          date: day.date,
          dayOfWeek: day.dayOfWeek,
          dayNumber: day.dayNumber,
          loggedMinutes,
          loggedFormatted: loggedMinutes > 0 ? this.formatDuration(loggedMinutes) : '',
          expectedMinutes,
          percentage: expectedMinutes > 0 ? Math.round((loggedMinutes / expectedMinutes) * 100) : 0,
          tasks: dayData ? Array.from(dayData.tasks.entries()).map(([name, mins]) => ({
            taskName: name,
            minutes: mins,
            formatted: this.formatDuration(mins),
          })) : [],
        });

        rowTotalLogged += loggedMinutes;
        if (hasSchedule) {
          rowTotalExpected += expectedMinutesPerDay;
        }
      }

      // Only include patterns that have at least some data or are in the active schedule
      if (rowTotalLogged > 0 || rowTotalExpected > 0) {
        rows.push({
          pattern,
          days: rowDays,
          totalLogged: rowTotalLogged,
          totalLoggedFormatted: this.formatDuration(rowTotalLogged),
          totalExpected: rowTotalExpected,
          overallPercentage: rowTotalExpected > 0 ? Math.round((rowTotalLogged / rowTotalExpected) * 100) : 0,
        });

        totalLogged += rowTotalLogged;
        totalExpected += rowTotalExpected;
      }
    }

    // Sort rows by schedule start time
    rows.sort((a, b) => a.pattern.startTime.localeCompare(b.pattern.startTime));

    return {
      reportType: 'schedule',
      startDate: filters.startDate,
      endDate: filters.endDate,
      generatedAt: new Date().toISOString(),
      filters: {
        goalIds: goalIdArray,
        taskIds: taskIdArray,
        category: filters.category,
      },
      summary: {
        totalMinutes: totalLogged,
        totalFormatted: this.formatDuration(totalLogged),
        totalExpectedMinutes: totalExpected,
        totalExpectedFormatted: this.formatDuration(totalExpected),
        overallPercentage: totalExpected > 0 ? Math.round((totalLogged / totalExpected) * 100) : 0,
        totalEntries,
        schedulesTracked: rows.length,
      },
      days,
      rows,
    };
  }

  private formatTimeRange(startTime: string, endTime: string): string {
    const formatTime = (time: string) => {
      const [h, m] = time.split(':').map(Number);
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      const meridiem = h >= 12 ? 'PM' : 'AM';
      return m === 0 ? `${hour12} ${meridiem}` : `${hour12}:${m.toString().padStart(2, '0')} ${meridiem}`;
    };
    return `${formatTime(startTime)} - ${formatTime(endTime)}`;
  }

  /**
   * Generate exportable report (for invoicing, mentor reports, assignment updates)
   */
  async generateExport(userId: string, filters: ExportReportDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    const viewType = filters.viewType || ReportViewType.DETAILED;
    let reportData: any;
    
    switch (viewType) {
      case ReportViewType.DETAILED:
        reportData = await this.getDetailedReport(userId, filters);
        break;
      case ReportViewType.SUMMARY:
        reportData = await this.getSummaryReport(userId, filters);
        break;
      case ReportViewType.DAY_BY_TASK:
        reportData = await this.getDayByTaskReport(userId, filters);
        break;
      case ReportViewType.DAY_TOTAL:
        reportData = await this.getDayTotalReport(userId, filters);
        break;
      default:
        reportData = await this.getDetailedReport(userId, filters);
    }

    const exportMeta = {
      title: filters.title || 'Time Report',
      generatedBy: user?.name || 'Unknown',
      generatedAt: new Date().toISOString(),
      clientName: filters.clientName,
      projectName: filters.projectName,
      notes: filters.notes,
      format: filters.format,
    };

    if (filters.format === ExportFormat.CSV) {
      return this.generateCSV(reportData, viewType, exportMeta);
    } else if (filters.format === ExportFormat.JSON) {
      return {
        ...exportMeta,
        data: reportData,
      };
    } else {
      // PDF would require a PDF library - return structured data for frontend rendering
      return {
        ...exportMeta,
        data: reportData,
        pdfReady: true,
      };
    }
  }

  /**
   * Get list of available goals for filtering
   */
  async getFilterableGoals(userId: string) {
    const goals = await this.prisma.goal.findMany({
      where: { userId },
      select: { id: true, title: true, color: true, category: true, status: true },
      orderBy: [{ status: 'asc' }, { title: 'asc' }],
    });

    return goals.map(g => ({
      id: g.id,
      title: g.title,
      color: g.color,
      category: g.category,
      isActive: g.status === GoalStatus.ACTIVE,
    }));
  }

  /**
   * Get list of available tasks for filtering
   */
  async getFilterableTasks(userId: string, goalId?: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        userId,
        ...(goalId ? { goalId } : {}),
      },
      select: { id: true, title: true, category: true, status: true, goalId: true },
      orderBy: { title: 'asc' },
    });

    return tasks;
  }

  // Helper methods for report generation

  private aggregateByGroup(
    entries: any[],
    groupBy: ReportGroupBy,
    totalMinutes: number,
    hourlyRate?: number,
  ): SummaryItem[] {
    const groups = new Map<string, { name: string; color?: string; minutes: number; count: number }>();

    for (const entry of entries) {
      let key: string;
      let name: string;
      let color: string | undefined;

      switch (groupBy) {
        case ReportGroupBy.GOAL:
          key = entry.goalId || 'no-goal';
          name = entry.goal?.title || 'No Goal';
          color = entry.goal?.color || '#94A3B8';
          break;
        case ReportGroupBy.TASK:
          key = entry.taskId || entry.taskName;
          name = entry.task?.title || entry.taskName;
          break;
        case ReportGroupBy.CATEGORY:
          key = entry.goal?.category || entry.task?.category || 'other';
          name = this.formatCategoryName(key);
          break;
        case ReportGroupBy.DATE:
          key = entry.date.toISOString().split('T')[0];
          name = key;
          break;
        default:
          key = 'other';
          name = 'Other';
      }

      if (!groups.has(key)) {
        groups.set(key, { name, color, minutes: 0, count: 0 });
      }
      const group = groups.get(key)!;
      group.minutes += entry.duration;
      group.count++;
    }

    return Array.from(groups.entries())
      .map(([id, data]) => ({
        id,
        name: data.name,
        color: data.color,
        totalMinutes: data.minutes,
        totalFormatted: this.formatDuration(data.minutes),
        totalHours: parseFloat((data.minutes / 60).toFixed(2)),
        percentage: totalMinutes > 0 ? Math.round((data.minutes / totalMinutes) * 100) : 0,
        entriesCount: data.count,
        billableAmount: hourlyRate ? parseFloat(((data.minutes / 60) * hourlyRate).toFixed(2)) : undefined,
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes);
  }

  private buildDateBreakdown(entries: any[], start: Date, end: Date) {
    const breakdown: Array<{ date: string; minutes: number; formatted: string }> = [];
    const dateMap = new Map<string, number>();

    entries.forEach(e => {
      const dateKey = e.date.toISOString().split('T')[0];
      dateMap.set(dateKey, (dateMap.get(dateKey) || 0) + e.duration);
    });

    // Fill in all dates in range
    const cursor = new Date(start);
    while (cursor <= end) {
      const dateKey = cursor.toISOString().split('T')[0];
      const minutes = dateMap.get(dateKey) || 0;
      breakdown.push({
        date: dateKey,
        minutes,
        formatted: this.formatDuration(minutes),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return breakdown;
  }

  private generateCSV(reportData: any, viewType: ReportViewType, meta: any): string {
    const lines: string[] = [];
    
    // Header
    lines.push(`"${meta.title}"`);
    lines.push(`"Generated by: ${meta.generatedBy}"`);
    lines.push(`"Generated at: ${meta.generatedAt}"`);
    if (meta.clientName) lines.push(`"Client: ${meta.clientName}"`);
    if (meta.projectName) lines.push(`"Project: ${meta.projectName}"`);
    lines.push(`"Period: ${reportData.startDate} to ${reportData.endDate}"`);
    lines.push('');

    if (viewType === ReportViewType.DETAILED) {
      // Detailed view - each entry as a row
      lines.push('"Date","Day","Start Time","End Time","Task","Goal","Duration (min)","Duration","Time Entry Notes","Task Notes"');
      
      for (const day of reportData.dailyBreakdown) {
        for (const entry of day.entries) {
          const startTime = entry.startedAt ? new Date(entry.startedAt).toLocaleTimeString() : '';
          const endTime = entry.endedAt ? new Date(entry.endedAt).toLocaleTimeString() : '';
          lines.push(`"${entry.date}","${entry.dayOfWeek}","${startTime}","${endTime}","${entry.taskName}","${entry.goal?.title || ''}","${entry.duration}","${entry.durationFormatted}","${entry.notes || ''}","${entry.taskNotes || ''}"`);
        }
        // Daily subtotal
        lines.push(`"${day.date}","${day.dayOfWeek}","","","DAILY TOTAL","","","${day.totalMinutes}","${day.totalFormatted}","",""`);
        lines.push('');
      }
    } else if (viewType === ReportViewType.DAY_BY_TASK) {
      // Day by Task view - aggregated hours per task per day (no timestamps)
      lines.push('"Date","Day","Task","Goal","Total Hours","Total Minutes","Duration"');
      
      for (const day of reportData.dailyBreakdown) {
        for (const task of day.tasks) {
          const hours = (task.totalMinutes / 60).toFixed(2);
          lines.push(`"${day.date}","${day.dayOfWeek}","${task.taskName}","${task.goalTitle || ''}","${hours}","${task.totalMinutes}","${task.totalFormatted}"`);
        }
        // Daily subtotal
        const dayHours = (day.totalMinutes / 60).toFixed(2);
        lines.push(`"${day.date}","${day.dayOfWeek}","DAILY TOTAL","","${dayHours}","${day.totalMinutes}","${day.totalFormatted}"`);
        lines.push('');
      }
    } else if (viewType === ReportViewType.DAY_TOTAL) {
      // Day Total view - just daily totals with merged task names
      lines.push('"Date","Day","Tasks Worked On","Total Hours","Total Minutes","Duration"');
      
      for (const day of reportData.dailyBreakdown) {
        lines.push(`"${day.date}","${day.dayOfWeek}","${day.taskNames}","${day.totalHours}","${day.totalMinutes}","${day.totalFormatted}"`);
      }
    } else {
      // Summary view - grouped totals
      lines.push(`"${reportData.groupBy.toUpperCase()}","Total Hours","Total Minutes","Entries","Percentage"${reportData.billable ? ',"Billable Amount"' : ''}`);
      
      for (const item of reportData.items) {
        const billableCol = reportData.billable ? `,"$${item.billableAmount}"` : '';
        lines.push(`"${item.name}","${item.totalHours}","${item.totalMinutes}","${item.entriesCount}","${item.percentage}%"${billableCol}`);
      }
    }

    // Grand total
    lines.push('');
    lines.push(`"GRAND TOTAL","${reportData.summary.totalHours} hours","${reportData.summary.totalMinutes} minutes","${reportData.summary.totalEntries} entries","100%"${reportData.billable ? `,"$${reportData.billable.totalAmount}"` : ''}`);

    if (meta.notes) {
      lines.push('');
      lines.push(`"Notes: ${meta.notes}"`);
    }

    return lines.join('\n');
  }

  private getSortOrder(sortBy?: ReportSortBy) {
    switch (sortBy) {
      case ReportSortBy.DATE_ASC:
        return [{ date: 'asc' as const }, { startedAt: 'asc' as const }];
      case ReportSortBy.DATE_DESC:
        return [{ date: 'desc' as const }, { startedAt: 'desc' as const }];
      case ReportSortBy.DURATION_ASC:
        return { duration: 'asc' as const };
      case ReportSortBy.DURATION_DESC:
        return { duration: 'desc' as const };
      default:
        return [{ date: 'asc' as const }, { startedAt: 'asc' as const }];
    }
  }

  private formatCategoryName(category: string): string {
    if (!category) return 'Other';
    return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase().replace(/_/g, ' ');
  }

  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private formatDuration(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) return `${mins}m`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  }
}
