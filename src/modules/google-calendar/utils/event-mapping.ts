import { GoogleEvent } from '../services/google-calendar-api.service';

/**
 * Why this file exists at all.
 *
 * A Google Calendar event and a GoalSlot ScheduleBlock are not the same kind
 * of object. A Google event is an instant on the timeline: "2026-09-03T09:00
 * +05:00 to 10:00". A ScheduleBlock (see prisma/schema.prisma) is a *weekly
 * template*: `dayOfWeek` 0-6 plus `startTime`/`endTime` as bare "HH:mm"
 * strings, with no date attached, repeating every week forever.
 *
 * So importing is a lossy projection, not a copy, and the two consequences
 * below are why the review step is not optional decoration:
 *
 *   1. The projection needs a timezone. "09:00 +05:00" is Wednesday 09:00 in
 *      Karachi and Tuesday 21:00 in Los Angeles — different day column,
 *      different row. There is no correct answer without knowing whose week
 *      this is, so the caller passes an IANA zone and it is used explicitly
 *      here rather than falling through to the server's own clock.
 *
 *   2. Recurrence collapses. Google returns a weekly standup as N expanded
 *      instances; all N project onto the same Wednesday 09:00 slot. Importing
 *      them naively creates N identical blocks (or, more likely, one block and
 *      N-1 conflict errors). They are deduplicated into a single candidate
 *      carrying its occurrence count instead.
 *
 * And some events simply have no representation as a weekly block. Those are
 * returned marked, not silently dropped — a user who cannot find their all-day
 * conference in the list assumes the import is broken.
 */

/** Matches CreateScheduleBlockDto.dayOfWeek: 0=Sunday .. 6=Saturday. */
const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type ImportBlockedReason = 'all-day' | 'spans-midnight' | 'zero-length';

export interface ImportCandidate {
  /** Google's event id, used to remember what has already been imported. */
  externalEventId: string;
  externalCalId: string;
  calendarName: string;
  title: string;
  /** Instant of the first occurrence, for showing a real date in the review list. */
  startsAt: string;
  endsAt: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** How many expanded instances collapsed into this one weekly slot. */
  occurrences: number;
  /**
   * Non-null when this event cannot become a ScheduleBlock. The row is shown
   * disabled with the reason rather than hidden.
   */
  blocked: ImportBlockedReason | null;
}

interface LocalSlot {
  dayOfWeek: number;
  time: string;
}

/**
 * Projects an instant into a weekday + wall-clock time in the given zone.
 *
 * `hourCycle: 'h23'` matters: the default for many locales is h12, and
 * `hour12: false` alone famously yields "24:00" for midnight in some ICU
 * versions — which fails CreateScheduleBlockDto's `HH:mm` regex and would
 * reject exactly the midnight-boundary events most likely to be imported.
 * Forcing the en-GB locale keeps the parts stable regardless of server locale.
 */
export function toLocalSlot(instant: Date, timeZone: string): LocalSlot | null {
  if (Number.isNaN(instant.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;

  if (!weekday || !hour || !minute) return null;
  const dayOfWeek = WEEKDAY_TO_INDEX[weekday];
  if (dayOfWeek === undefined) return null;

  return { dayOfWeek, time: `${hour}:${minute}` };
}

/**
 * Rejects anything Intl would throw a RangeError on. Called once per request
 * with a value that came from the browser, so an unknown zone degrades to UTC
 * instead of 500ing the whole preview.
 */
export function normalizeTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function eventInstant(
  point: GoogleEvent['start'] | GoogleEvent['end'],
): Date | null {
  if (!point?.dateTime) return null;
  const parsed = new Date(point.dateTime);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Turns one calendar's expanded events into the review list.
 *
 * Deduplication key is (dayOfWeek, startTime, endTime, title) rather than
 * Google's `recurringEventId`, because two *different* recurring series that
 * happen to project onto the identical weekly slot with the identical title
 * would still produce duplicate blocks — and because a series whose instances
 * were individually moved should legitimately yield more than one candidate.
 * The key describes the block that would be created, which is the thing being
 * deduplicated.
 *
 * The earliest instance wins the `externalEventId`, so re-running the preview
 * over the same window keeps pointing at the same row in ImportedCalendarEvent
 * and the "already imported" badge stays put.
 */
export function buildCandidates(
  events: GoogleEvent[],
  context: { externalCalId: string; calendarName: string; timeZone: string },
): ImportCandidate[] {
  const bySlot = new Map<string, ImportCandidate>();

  for (const event of events) {
    const title = event.summary?.trim() || '(No title)';

    const isAllDay = Boolean(event.start?.date && !event.start?.dateTime);
    const start = eventInstant(event.start);
    const end = eventInstant(event.end);

    if (isAllDay || !start || !end) {
      // All-day events carry `date`, not `dateTime`: there is no time range to
      // map onto a block. Keyed by event id so each stays its own row.
      const allDayStart = event.start?.date ?? new Date().toISOString();
      bySlot.set(`allday:${event.id}`, {
        externalEventId: event.id,
        externalCalId: context.externalCalId,
        calendarName: context.calendarName,
        title,
        startsAt: allDayStart,
        endsAt: event.end?.date ?? allDayStart,
        dayOfWeek: 0,
        startTime: '00:00',
        endTime: '00:00',
        occurrences: 1,
        blocked: 'all-day',
      });
      continue;
    }

    const startSlot = toLocalSlot(start, context.timeZone);
    const endSlot = toLocalSlot(end, context.timeZone);
    if (!startSlot || !endSlot) continue;

    // ScheduleBlock has no date, so it cannot express "Friday 23:00 until
    // Saturday 01:00" — and ScheduleService.assertValidRange rejects an
    // inverted range outright. Surfacing the reason beats letting the import
    // call fail per-event with a validation error the user cannot act on.
    let blocked: ImportBlockedReason | null = null;
    if (endSlot.time === startSlot.time) blocked = 'zero-length';
    else if (endSlot.time < startSlot.time) blocked = 'spans-midnight';

    const key = `${startSlot.dayOfWeek}|${startSlot.time}|${endSlot.time}|${title}`;
    const existing = bySlot.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }

    bySlot.set(key, {
      externalEventId: event.id,
      externalCalId: context.externalCalId,
      calendarName: context.calendarName,
      title,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      dayOfWeek: startSlot.dayOfWeek,
      startTime: startSlot.time,
      endTime: endSlot.time,
      occurrences: 1,
      blocked,
    });
  }

  return [...bySlot.values()].sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
  );
}

/** Minutes from midnight, for overlap comparison against existing blocks. */
export function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Same half-open comparison ScheduleService.checkTimeConflict uses, so the
 * review screen's "conflicts with" warning agrees with what the create call
 * will actually reject. Back-to-back blocks (10:00-11:00, 11:00-12:00) do not
 * conflict.
 */
export function overlaps(
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
): boolean {
  return (
    toMinutes(a.startTime) < toMinutes(b.endTime) &&
    toMinutes(a.endTime) > toMinutes(b.startTime)
  );
}
