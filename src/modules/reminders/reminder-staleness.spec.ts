import {
  isInstructionReminderDue,
  isReportViewReminderDue,
} from './reminder-staleness';

const NOW = new Date('2026-08-11T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// Helper only for the boundary cases, where the exact fraction of a day
// matters more than the readability of a literal ISO string.
const daysBeforeNow = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

describe('isReportViewReminderDue', () => {
  it('is due when the report has never been viewed', () => {
    expect(isReportViewReminderDue(NOW, null, null)).toBe(true);
  });

  it('is due when viewed 8 days ago and no reminder has gone out yet', () => {
    const lastViewedAt = new Date('2026-08-03T00:00:00Z'); // 8 days before NOW
    expect(isReportViewReminderDue(NOW, lastViewedAt, null)).toBe(true);
  });

  it('is not due when viewed 3 days ago', () => {
    const lastViewedAt = new Date('2026-08-08T00:00:00Z'); // 3 days before NOW
    expect(isReportViewReminderDue(NOW, lastViewedAt, null)).toBe(false);
  });

  it('is not due when viewed 8 days ago but a reminder already went out 2 days ago', () => {
    const lastViewedAt = new Date('2026-08-03T00:00:00Z'); // 8 days before NOW
    const lastViewReminderAt = new Date('2026-08-09T00:00:00Z'); // 2 days before NOW
    expect(isReportViewReminderDue(NOW, lastViewedAt, lastViewReminderAt)).toBe(
      false,
    );
  });

  it('is due again when viewed 8 days ago and the last reminder was itself 8 days ago', () => {
    const lastViewedAt = new Date('2026-08-03T00:00:00Z'); // 8 days before NOW
    const lastViewReminderAt = new Date('2026-08-03T00:00:00Z'); // 8 days before NOW
    expect(isReportViewReminderDue(NOW, lastViewedAt, lastViewReminderAt)).toBe(
      true,
    );
  });

  // The staleness check is a >= comparison against 7 days, so the sweep
  // must not fire a day early (6.99 days) but must fire the instant the
  // threshold is crossed (7.0 days exactly).
  it('is not due at 6.99 days since last viewed, just under the staleness threshold', () => {
    const lastViewedAt = daysBeforeNow(6.99);
    expect(isReportViewReminderDue(NOW, lastViewedAt, null)).toBe(false);
  });

  it('is due at exactly 7.0 days since last viewed', () => {
    const lastViewedAt = daysBeforeNow(7);
    expect(isReportViewReminderDue(NOW, lastViewedAt, null)).toBe(true);
  });

  // Same >= boundary applies to the second gate (the reminder-interval
  // check), independent of how stale the view itself is.
  it('is not due when the last reminder was 6.99 days ago, even though the view is long stale', () => {
    const lastViewedAt = new Date('2026-07-01T00:00:00Z'); // well past the 7-day staleness threshold
    const lastViewReminderAt = daysBeforeNow(6.99);
    expect(isReportViewReminderDue(NOW, lastViewedAt, lastViewReminderAt)).toBe(
      false,
    );
  });

  it('is due when the last reminder was exactly 7.0 days ago', () => {
    const lastViewedAt = new Date('2026-07-01T00:00:00Z'); // well past the 7-day staleness threshold
    const lastViewReminderAt = daysBeforeNow(7);
    expect(isReportViewReminderDue(NOW, lastViewedAt, lastViewReminderAt)).toBe(
      true,
    );
  });
});

describe('isInstructionReminderDue', () => {
  it('is due when never reminded', () => {
    expect(isInstructionReminderDue(NOW, null)).toBe(true);
  });

  it('is not due when reminded 1 day ago', () => {
    const lastReminderAt = new Date('2026-08-10T00:00:00Z'); // 1 day before NOW
    expect(isInstructionReminderDue(NOW, lastReminderAt)).toBe(false);
  });

  it('is due when reminded 3 days ago', () => {
    const lastReminderAt = new Date('2026-08-08T00:00:00Z'); // 3 days before NOW
    expect(isInstructionReminderDue(NOW, lastReminderAt)).toBe(true);
  });

  // Pin the >= 2-day boundary precisely, same reasoning as the report
  // staleness edge above.
  it('is not due at 1.99 days since the last reminder, just under the threshold', () => {
    const lastReminderAt = daysBeforeNow(1.99);
    expect(isInstructionReminderDue(NOW, lastReminderAt)).toBe(false);
  });

  it('is due at exactly 2.0 days since the last reminder', () => {
    const lastReminderAt = daysBeforeNow(2);
    expect(isInstructionReminderDue(NOW, lastReminderAt)).toBe(true);
  });
});
