/**
 * Compute the ISO-8601 week key for a given date as "YYYY-Www".
 * Inline implementation because `date-fns` is not a runtime dep here.
 *
 * Algorithm: ISO weeks start Monday; the week containing Thursday determines
 * the year-and-week number. Reference: ECMA-402 + ISO-8601.
 */
export function isoWeekKey(input: Date = new Date()): string {
  // Copy in UTC so DST does not shift day-of-week boundaries.
  const d = new Date(
    Date.UTC(
      input.getUTCFullYear(),
      input.getUTCMonth(),
      input.getUTCDate(),
    ),
  );
  // Shift to Thursday of the current ISO week.
  const dayNum = d.getUTCDay() || 7; // Sun=0 → 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, '0')}`;
}
