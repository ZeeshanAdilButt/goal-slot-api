/**
 * Per-user rate limits for POST /notes/:id/summary.
 *
 * Kept in their own file because the `ThrottlerModule.forRoot` registration
 * and the `@Throttle` decorator must agree on both the NAMES and the numbers,
 * and they live in two different files — coach-voice-intent duplicates its
 * four constants across exactly that pair and relies on a comment to keep them
 * in step. One shared module is cheaper than that promise.
 *
 * Deliberately the inverse of coach-voice-intent's limits (20/min, 600/day).
 * That endpoint is tiny and fires on nearly every utterance; this one reads a
 * whole lecture, spends thousands of tokens and takes tens of seconds. A
 * handful an hour is generous for a human summarizing their own notes, and it
 * is the backstop for a client bug that retries in a loop — the sort that
 * would otherwise drain a BYOK budget overnight.
 */
export const NOTE_SUMMARY_HOURLY_LIMIT = 5;
export const NOTE_SUMMARY_HOURLY_TTL_MS = 3_600_000;
export const NOTE_SUMMARY_DAILY_LIMIT = 20;
export const NOTE_SUMMARY_DAILY_TTL_MS = 86_400_000;
