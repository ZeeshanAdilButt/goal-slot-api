import { isValidIsoWeekKey, isoWeekKey } from './iso-week';

describe('isValidIsoWeekKey', () => {
  describe('shape', () => {
    it.each(['', '2026', '2026-W', '2026-W1', '26-W01', '2026W01', 'abcd-Wxy', '2026-w01'])(
      'rejects malformed input %p',
      (value) => {
        expect(isValidIsoWeekKey(value)).toBe(false);
      },
    );
  });

  describe('range', () => {
    it.each(['2026-W00', '2026-W54', '2026-W99'])('rejects %s', (value) => {
      expect(isValidIsoWeekKey(value)).toBe(false);
    });

    it.each(['2026-W01', '2026-W22', '2026-W52'])('accepts %s', (value) => {
      expect(isValidIsoWeekKey(value)).toBe(true);
    });
  });

  /**
   * The case a naive 01-52 range check gets wrong, and the reason this
   * validator round-trips instead. A year has 53 ISO weeks when Jan 1 is a
   * Thursday (or a Wednesday in a leap year).
   */
  describe('53-week years', () => {
    it('accepts 2026-W53, because Jan 1 2026 is a Thursday', () => {
      expect(new Date(Date.UTC(2026, 0, 1)).getUTCDay()).toBe(4); // Thursday
      expect(isValidIsoWeekKey('2026-W53')).toBe(true);
    });

    it('rejects 2025-W53, because 2025 only has 52 ISO weeks', () => {
      expect(isValidIsoWeekKey('2025-W53')).toBe(false);
    });

    it('accepts 2020-W53 (leap year starting on a Wednesday)', () => {
      expect(isValidIsoWeekKey('2020-W53')).toBe(true);
    });
  });

  /**
   * The invariant that matters in practice: every key the app can actually
   * generate must validate, since isoWeekKey() is what the read paths default
   * weekKey to. Anything it emits that this rejects would be unreachable data.
   */
  describe('agrees with isoWeekKey over a long date range', () => {
    it('accepts every key isoWeekKey produces across 2019-2031', () => {
      const day = new Date(Date.UTC(2019, 0, 1));
      const end = new Date(Date.UTC(2031, 11, 31));
      const rejected: string[] = [];

      while (day <= end) {
        const key = isoWeekKey(day);
        if (!isValidIsoWeekKey(key)) rejected.push(`${day.toISOString().slice(0, 10)} -> ${key}`);
        day.setUTCDate(day.getUTCDate() + 1);
      }

      expect(rejected).toEqual([]);
    });
  });
});
