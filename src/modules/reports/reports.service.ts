import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GoalStatus } from '@prisma/client';

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
