// Pure staleness-check logic shared by the reminder dispatch path. No
// NestJS, no Prisma, no I/O - just date arithmetic, so it can be tested
// and reasoned about without a database or a running app.

const REPORT_STALE_AFTER_DAYS = 7;
const REPORT_REMINDER_INTERVAL_DAYS = 7;
const INSTRUCTION_REMINDER_INTERVAL_DAYS = 2;

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

// True when a mentor's view of a mentee's report is stale enough to remind
// about, and no reminder has already gone out for the current stale period.
export function isReportViewReminderDue(
  now: Date,
  lastViewedAt: Date | null,
  lastViewReminderAt: Date | null,
): boolean {
  const viewedStale = lastViewedAt === null || daysBetween(now, lastViewedAt) >= REPORT_STALE_AFTER_DAYS;
  if (!viewedStale) return false;
  const reminderDue = lastViewReminderAt === null || daysBetween(now, lastViewReminderAt) >= REPORT_REMINDER_INTERVAL_DAYS;
  return reminderDue;
}

// True when a pending instruction is due its next nudge.
export function isInstructionReminderDue(now: Date, lastReminderAt: Date | null): boolean {
  return lastReminderAt === null || daysBetween(now, lastReminderAt) >= INSTRUCTION_REMINDER_INTERVAL_DAYS;
}
