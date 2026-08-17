/**
 * Deterministic "today" + relative-date lookup table injected into every
 * Coach request (see `buildUserContextMessage` in coach-ai.service.ts).
 *
 * WHY THIS EXISTS
 * ----------------
 * CREATE_TASK's prompt tells the model that "by Friday", "tomorrow", "in one
 * week" etc. should become a bare `YYYY-MM-DD` due date — but the model was
 * never told what today's date is, so it had nothing to compute a relative
 * date FROM. It would either guess (frequently wrong: LLM date arithmetic
 * off a training-data-recency prior, not the real clock) or correctly refuse
 * per the "never invent a date" instruction and silently omit the due date.
 * Either way, "remind me to clean the kitchen in one week" produced an
 * unreliable result.
 *
 * Rather than hand the model a bare "today: YYYY-MM-DD" and TRUST it to do
 * calendar arithmetic correctly inside free-form generation (still not
 * reliable — see above), this module precomputes the answer for every
 * relative phrase the prompt tells the model to expect, so the model's job
 * degrades from "do date math" to "copy the row that matches". All of this
 * is pure, deterministic, and unit-testable without a live model call.
 *
 * Every date is computed in UTC-day arithmetic (server clock, not the
 * caller's device timezone), matching how `dueDate` is stored end-to-end:
 * the API builds `Task.dueDate` from a bare "YYYY-MM-DD" via `new Date(...)`
 * (tasks.service.ts), which lands at UTC midnight, and the mobile app reads
 * it back as a UTC-day key (`toDateKeyFromApi`, calendar-math.ts). Doing the
 * arithmetic in UTC calendar days, not local wall-clock days, keeps this
 * server-side computation consistent with that convention rather than
 * introducing a THIRD notion of "day" alongside it.
 */

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Truncates to the UTC calendar day (drops any time-of-day component). */
function utcDayOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** "YYYY-MM-DD" for a Date already truncated to a UTC calendar day. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Adds `days` UTC calendar days. Negative values go backward. Rolls over month/year boundaries via the platform Date implementation — no manual carry logic to get wrong. */
export function addUtcDays(base: Date, days: number): Date {
  const d = utcDayOnly(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Adds calendar months, clamping the day-of-month into the target month when
 * it would otherwise overflow (Jan 31 + 1 month -> Feb 28, not Mar 3). This
 * is the month/year-boundary case that a naive `setUTCMonth` call gets wrong:
 * `setUTCMonth` on Jan 31 rolling to a 28-day February overflows into March.
 */
export function addUtcMonths(base: Date, months: number): Date {
  const d = utcDayOnly(base);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  const targetIndex = m + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

/** "today: 2026-08-17 (Monday)" — the single fact every other computation is anchored to. */
export function todayContextLine(now: Date = new Date()): string {
  const today = utcDayOnly(now);
  return `today: ${toIsoDate(today)} (${WEEKDAY_NAMES[today.getUTCDay()]})`;
}

/**
 * The full relative-date reference table, as plain-text lines ready to drop
 * into the Operator profile context. Every label here MUST stay in sync with
 * the phrases CREATE_TASK's prompt (coach-ai.prompts.ts) tells the model to
 * expect — the model is instructed to copy a matching row verbatim rather
 * than compute the date itself.
 */
export function buildRelativeDateReference(now: Date = new Date()): string[] {
  const today = utcDayOnly(now);
  const lines: string[] = [];

  lines.push(todayContextLine(today));
  lines.push(`tomorrow: ${toIsoDate(addUtcDays(today, 1))}`);
  for (const n of [2, 3, 4, 5, 6]) {
    lines.push(`in ${n} days: ${toIsoDate(addUtcDays(today, n))}`);
  }
  for (const n of [1, 2, 3, 4]) {
    lines.push(`in ${n} week${n === 1 ? '' : 's'}: ${toIsoDate(addUtcDays(today, n * 7))}`);
  }
  for (const n of [1, 2, 3]) {
    lines.push(`in ${n} month${n === 1 ? '' : 's'}: ${toIsoDate(addUtcMonths(today, n))}`);
  }

  // Every weekday's NEXT occurrence, 1-7 days out. "next Tuesday" when today
  // IS Tuesday means 7 days from now, not today — the +1 offset below is
  // what makes that true for every weekday, todayIso included.
  const todayDow = today.getUTCDay();
  for (let offset = 1; offset <= 7; offset++) {
    const dow = (todayDow + offset) % 7;
    lines.push(`next ${WEEKDAY_NAMES[dow]}: ${toIsoDate(addUtcDays(today, offset))}`);
  }

  // "this weekend" / "before the weekend": if today already IS Saturday or
  // Sunday, the weekend is today (0 days out) — a Sunday user asking to do
  // something "this weekend" means today, not seven days from now. On any
  // weekday it resolves to the upcoming Saturday.
  const daysUntilSaturday = todayDow === 0 || todayDow === 6 ? 0 : 6 - todayDow;
  lines.push(`this weekend: ${toIsoDate(addUtcDays(today, daysUntilSaturday))}`);

  return lines;
}
