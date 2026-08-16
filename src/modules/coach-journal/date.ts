/**
 * Single source of truth for the journal's `YYYY-MM-DD` date format.
 *
 * Previously this pattern was hand-copied as an identical literal in four
 * places (the controller's route param regex plus three DTOs' `@Matches`
 * decorators) — the kind of duplication where a future format change (or a
 * typo fix) only lands in some of the copies. `PATTERN` is the raw source
 * string, needed by the controller because Nest's route-param regex syntax
 * (`:date(...)`) takes a string, not a RegExp object; `YYYY_MM_DD` is the
 * anchored RegExp the DTOs validate against.
 */
export const YYYY_MM_DD_PATTERN = '\\d{4}-\\d{2}-\\d{2}';

export const YYYY_MM_DD = new RegExp(`^${YYYY_MM_DD_PATTERN}$`);
