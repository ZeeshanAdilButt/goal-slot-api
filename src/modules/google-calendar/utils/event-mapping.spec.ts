import { GoogleEvent } from '../services/google-calendar-api.service';
import {
  buildCandidates,
  normalizeTimeZone,
  overlaps,
  toLocalSlot,
  toMinutes,
} from './event-mapping';

function timedEvent(
  id: string,
  summary: string,
  startISO: string,
  endISO: string,
): GoogleEvent {
  return {
    id,
    summary,
    status: 'confirmed',
    start: { dateTime: startISO },
    end: { dateTime: endISO },
  };
}

const CONTEXT = {
  externalCalId: 'primary',
  calendarName: 'Personal',
  timeZone: 'Asia/Karachi',
};

describe('toLocalSlot', () => {
  // The same instant is a different day column depending on the viewer, which
  // is exactly why the timezone is an explicit input instead of the server's.
  it('projects one instant into different weekdays per timezone', () => {
    // 2026-09-02T18:00Z is Wednesday 23:00 in Karachi (+05:00) and
    // Wednesday 11:00 in Los Angeles (-07:00).
    const instant = new Date('2026-09-02T18:00:00Z');
    expect(toLocalSlot(instant, 'Asia/Karachi')).toEqual({
      dayOfWeek: 3,
      time: '23:00',
    });
    expect(toLocalSlot(instant, 'America/Los_Angeles')).toEqual({
      dayOfWeek: 3,
      time: '11:00',
    });
  });

  it('rolls over the day boundary in the viewer timezone', () => {
    // Wednesday 20:00 UTC is already Thursday 01:00 in Karachi.
    expect(
      toLocalSlot(new Date('2026-09-02T20:00:00Z'), 'Asia/Karachi'),
    ).toEqual({ dayOfWeek: 4, time: '01:00' });
  });

  // hourCycle 'h23' is load-bearing: hour12:false alone renders midnight as
  // "24:00" under some ICU builds, which fails the HH:mm regex the schedule
  // DTO enforces and would reject exactly the midnight-boundary events.
  it('renders midnight as 00:00, never 24:00', () => {
    const slot = toLocalSlot(new Date('2026-09-02T19:00:00Z'), 'Asia/Karachi');
    expect(slot?.time).toBe('00:00');
    expect(slot?.time).toMatch(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/);
  });

  it('returns null for an unparseable instant', () => {
    expect(toLocalSlot(new Date('nonsense'), 'UTC')).toBeNull();
  });
});

describe('normalizeTimeZone', () => {
  it('passes through a valid IANA zone', () => {
    expect(normalizeTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  // The value arrives from the browser, so a junk one must degrade rather than
  // throw a RangeError out of the middle of a preview request.
  it('falls back to UTC for an unknown or missing zone', () => {
    expect(normalizeTimeZone('Mars/Olympus_Mons')).toBe('UTC');
    expect(normalizeTimeZone(undefined)).toBe('UTC');
    expect(normalizeTimeZone('')).toBe('UTC');
  });
});

describe('buildCandidates', () => {
  it('maps a timed event onto a weekly slot', () => {
    const [candidate] = buildCandidates(
      [
        timedEvent(
          'evt-1',
          'Design review',
          '2026-09-02T09:00:00+05:00',
          '2026-09-02T10:30:00+05:00',
        ),
      ],
      CONTEXT,
    );

    expect(candidate).toMatchObject({
      externalEventId: 'evt-1',
      title: 'Design review',
      dayOfWeek: 3,
      startTime: '09:00',
      endTime: '10:30',
      occurrences: 1,
      blocked: null,
      calendarName: 'Personal',
    });
  });

  // The reason the import does not simply create one block per Google event:
  // a weekly meeting arrives as many expanded instances that all describe the
  // same weekly block.
  it('collapses repeated instances of the same weekly slot into one candidate', () => {
    const candidates = buildCandidates(
      [
        timedEvent(
          'w1',
          'Standup',
          '2026-09-02T09:00:00+05:00',
          '2026-09-02T09:15:00+05:00',
        ),
        timedEvent(
          'w2',
          'Standup',
          '2026-09-09T09:00:00+05:00',
          '2026-09-09T09:15:00+05:00',
        ),
        timedEvent(
          'w3',
          'Standup',
          '2026-09-16T09:00:00+05:00',
          '2026-09-16T09:15:00+05:00',
        ),
      ],
      CONTEXT,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].occurrences).toBe(3);
    // The earliest instance keeps the id, so the "already imported" badge
    // stays attached across repeated previews of the same window.
    expect(candidates[0].externalEventId).toBe('w1');
  });

  it('keeps instances that moved to a different slot as separate candidates', () => {
    const candidates = buildCandidates(
      [
        timedEvent(
          'a',
          'Standup',
          '2026-09-02T09:00:00+05:00',
          '2026-09-02T09:15:00+05:00',
        ),
        timedEvent(
          'b',
          'Standup',
          '2026-09-09T14:00:00+05:00',
          '2026-09-09T14:15:00+05:00',
        ),
      ],
      CONTEXT,
    );
    expect(candidates).toHaveLength(2);
  });

  // Marked rather than dropped: a user who cannot see their all-day conference
  // in the review list concludes the import is broken.
  it('marks all-day events as blocked instead of hiding them', () => {
    const [candidate] = buildCandidates(
      [
        {
          id: 'allday-1',
          summary: 'Conference',
          status: 'confirmed',
          start: { date: '2026-09-02' },
          end: { date: '2026-09-04' },
        },
      ],
      CONTEXT,
    );
    expect(candidate.blocked).toBe('all-day');
    expect(candidate.title).toBe('Conference');
  });

  // ScheduleService.assertValidRange rejects an inverted range outright, so
  // catching it here turns an unexplainable per-event failure into a reason
  // shown next to the row.
  it('marks an event crossing local midnight as spans-midnight', () => {
    const [candidate] = buildCandidates(
      [
        timedEvent(
          'night',
          'Night shift',
          '2026-09-02T23:00:00+05:00',
          '2026-09-03T02:00:00+05:00',
        ),
      ],
      CONTEXT,
    );
    expect(candidate.blocked).toBe('spans-midnight');
  });

  it('marks a zero-length event', () => {
    const [candidate] = buildCandidates(
      [
        timedEvent(
          'ping',
          'Reminder',
          '2026-09-02T09:00:00+05:00',
          '2026-09-02T09:00:00+05:00',
        ),
      ],
      CONTEXT,
    );
    expect(candidate.blocked).toBe('zero-length');
  });

  it('falls back to a placeholder title for an untitled event', () => {
    const [candidate] = buildCandidates(
      [
        timedEvent(
          'u',
          '  ',
          '2026-09-02T09:00:00+05:00',
          '2026-09-02T10:00:00+05:00',
        ),
      ],
      CONTEXT,
    );
    expect(candidate.title).toBe('(No title)');
  });

  it('sorts candidates by day then start time', () => {
    const candidates = buildCandidates(
      [
        timedEvent(
          'c',
          'Friday late',
          '2026-09-04T16:00:00+05:00',
          '2026-09-04T17:00:00+05:00',
        ),
        timedEvent(
          'a',
          'Monday early',
          '2026-08-31T08:00:00+05:00',
          '2026-08-31T09:00:00+05:00',
        ),
        timedEvent(
          'b',
          'Monday later',
          '2026-08-31T11:00:00+05:00',
          '2026-08-31T12:00:00+05:00',
        ),
      ],
      CONTEXT,
    );
    expect(candidates.map((c) => c.title)).toEqual([
      'Monday early',
      'Monday later',
      'Friday late',
    ]);
  });
});

describe('overlaps', () => {
  it('detects a genuine overlap', () => {
    expect(
      overlaps(
        { startTime: '09:00', endTime: '10:00' },
        { startTime: '09:30', endTime: '10:30' },
      ),
    ).toBe(true);
  });

  // Half-open on purpose, matching ScheduleService.checkTimeConflict, so the
  // review screen's warning agrees with what the create call actually rejects.
  it('treats back-to-back blocks as non-overlapping', () => {
    expect(
      overlaps(
        { startTime: '09:00', endTime: '10:00' },
        { startTime: '10:00', endTime: '11:00' },
      ),
    ).toBe(false);
  });

  it('converts times to minutes from midnight', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('23:59')).toBe(1439);
  });
});
