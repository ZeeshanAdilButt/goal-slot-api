import { registerDecorator, ValidationOptions } from 'class-validator';
import { isValidIsoWeekKey } from '../iso-week';

/**
 * Validates that a string is a real ISO-8601 week key ("YYYY-Www").
 *
 * Replaces a bare `@Matches(/^\d{4}-W\d{2}$/)`, which only checked the shape.
 * That let `2026-W00`, `2026-W54` and `2026-W99` through: rows saved under
 * those keys can never be produced or looked up by `isoWeekKey()`, which is
 * what every read path defaults to, so they become orphaned records that any
 * week-based grouping silently misbuckets or skips.
 *
 * The range check lives in `isValidIsoWeekKey`, which round-trips through the
 * one existing ISO implementation rather than hardcoding 01-52 - some years
 * genuinely have 53 weeks (2026 among them).
 */
export function IsIsoWeekKey(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIsoWeekKey',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && isValidIsoWeekKey(value);
        },
        defaultMessage() {
          return 'weekKey must be a valid ISO-8601 week, e.g. 2026-W22';
        },
      },
    });
  };
}
