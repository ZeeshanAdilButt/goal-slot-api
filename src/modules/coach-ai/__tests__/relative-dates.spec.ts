import {
  addUtcDays,
  addUtcMonths,
  buildRelativeDateReference,
  todayContextLine,
  toIsoDate,
} from '../relative-dates';

describe('todayContextLine', () => {
  it('reports the UTC calendar day and weekday name', () => {
    // 2026-08-17 is a Monday.
    expect(todayContextLine(new Date('2026-08-17T14:32:00Z'))).toBe(
      'today: 2026-08-17 (Monday)',
    );
  });

  it('truncates a time-of-day component to the UTC calendar day', () => {
    expect(todayContextLine(new Date('2026-08-17T23:59:59Z'))).toBe(
      'today: 2026-08-17 (Monday)',
    );
  });
});

describe('addUtcDays', () => {
  it('adds within a month with no boundary crossing', () => {
    expect(toIsoDate(addUtcDays(new Date('2026-08-17T00:00:00Z'), 3))).toBe(
      '2026-08-20',
    );
  });

  it('rolls over a month boundary', () => {
    expect(toIsoDate(addUtcDays(new Date('2026-08-28T00:00:00Z'), 7))).toBe(
      '2026-09-04',
    );
  });

  it('rolls over a year boundary', () => {
    expect(toIsoDate(addUtcDays(new Date('2026-12-28T00:00:00Z'), 7))).toBe(
      '2027-01-04',
    );
  });
});

describe('addUtcMonths', () => {
  it('adds a plain month with no day-length issue', () => {
    expect(toIsoDate(addUtcMonths(new Date('2026-08-17T00:00:00Z'), 1))).toBe(
      '2026-09-17',
    );
  });

  it('rolls a year boundary (Dec + 1 month -> Jan of the next year)', () => {
    expect(toIsoDate(addUtcMonths(new Date('2026-12-15T00:00:00Z'), 1))).toBe(
      '2027-01-15',
    );
  });

  it('clamps day-of-month when the target month is shorter (Jan 31 + 1 month -> Feb 28, non-leap year)', () => {
    expect(toIsoDate(addUtcMonths(new Date('2026-01-31T00:00:00Z'), 1))).toBe(
      '2026-02-28',
    );
  });

  it('clamps into a leap February correctly (Jan 31 2028 + 1 month -> Feb 29 2028)', () => {
    expect(toIsoDate(addUtcMonths(new Date('2028-01-31T00:00:00Z'), 1))).toBe(
      '2028-02-29',
    );
  });
});

describe('buildRelativeDateReference — "in one week" and friends from a known today', () => {
  it('computes "in 1 week" correctly from an ordinary Monday', () => {
    const lines = buildRelativeDateReference(new Date('2026-08-17T09:00:00Z'));
    expect(lines).toContain('today: 2026-08-17 (Monday)');
    expect(lines).toContain('tomorrow: 2026-08-18');
    expect(lines).toContain('in 1 week: 2026-08-24');
    expect(lines).toContain('in 2 weeks: 2026-08-31');
  });

  it('computes "in one week" correctly across a month/year boundary (Dec 28 -> Jan 4)', () => {
    const lines = buildRelativeDateReference(new Date('2026-12-28T09:00:00Z'));
    expect(lines).toContain('today: 2026-12-28 (Monday)');
    expect(lines).toContain('in 1 week: 2027-01-04');
  });

  it('resolves "next <weekday>" to 7 days out, not today, when today IS that weekday', () => {
    // 2026-08-17 is a Monday.
    const lines = buildRelativeDateReference(new Date('2026-08-17T09:00:00Z'));
    expect(lines).toContain('next Monday: 2026-08-24');
    // The very next Tuesday (tomorrow) should be 1 day out.
    expect(lines).toContain('next Tuesday: 2026-08-18');
  });

  it('resolves "this weekend" to today when today is already Saturday or Sunday', () => {
    const saturday = buildRelativeDateReference(new Date('2026-08-22T09:00:00Z'));
    expect(saturday).toContain('this weekend: 2026-08-22');

    const sunday = buildRelativeDateReference(new Date('2026-08-23T09:00:00Z'));
    expect(sunday).toContain('this weekend: 2026-08-23');
  });

  it('resolves "this weekend" to the upcoming Saturday on a weekday', () => {
    // 2026-08-17 is a Monday; the upcoming Saturday is 2026-08-22.
    const lines = buildRelativeDateReference(new Date('2026-08-17T09:00:00Z'));
    expect(lines).toContain('this weekend: 2026-08-22');
  });

  it('handles a month-end + "in 1 month" boundary inside the full table', () => {
    const lines = buildRelativeDateReference(new Date('2026-01-31T09:00:00Z'));
    expect(lines).toContain('in 1 month: 2026-02-28');
  });
});
