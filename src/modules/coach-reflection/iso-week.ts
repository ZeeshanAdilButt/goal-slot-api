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
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()),
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

/**
 * True when `weekKey` is a real ISO-8601 week for the year it names.
 *
 * Validated by round-tripping through `isoWeekKey()` rather than by
 * range-checking the number, because the valid range is not fixed: most years
 * have 52 ISO weeks, but a year has 53 when Jan 1 falls on a Thursday (or on a
 * Wednesday in a leap year). 2026 is one of those, so `2026-W53` is a real week
 * while `2025-W53` is not, and a hardcoded 01-52 check would reject genuine
 * data.
 *
 * Reconstructing the Thursday of the claimed week and asking `isoWeekKey()`
 * what week that date actually falls in keeps exactly one implementation of the
 * ISO rules in this codebase. A second copy could drift from the first, and the
 * first is the one that generates every key we store.
 *
 * Out-of-range inputs land in a different week (or year) than they claim, so
 * they fail to round-trip: W00 walks back into the previous year, W54 forward
 * into the next, and W53 in a 52-week year resolves to W01 of the year after.
 */
export function isValidIsoWeekKey(weekKey: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!match) return false;

  const year = Number(match[1]);
  const week = Number(match[2]);

  // Cheap bounds first, so absurd input never reaches the date arithmetic.
  if (week < 1 || week > 53) return false;

  // Jan 4 is always in ISO week 1, so stepping from it to that week's Thursday
  // and then forward in whole weeks lands on the Thursday of `week`.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = jan4.getUTCDay() || 7; // Sun=0 -> 7
  const thursday = new Date(jan4);
  thursday.setUTCDate(jan4.getUTCDate() + 4 - jan4DayNum + (week - 1) * 7);

  return isoWeekKey(thursday) === weekKey;
}
