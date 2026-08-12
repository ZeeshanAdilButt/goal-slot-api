/**
 * Tunables for the cross-device active timer session.
 *
 * Plain module constants on purpose. This repo has previously taken the whole
 * API down at boot because a provider read configuration inside a constructor,
 * so nothing here touches ConfigService, process.env, or the database at
 * import time.
 */

/**
 * Ceiling on how much of a single session can become billable time.
 *
 * A forgotten timer is the normal failure mode, not a 14-hour deep work
 * session, so stopping a three-day-old session must never quietly produce a
 * 4320-minute TimeEntry. Twelve hours is comfortably above any real tracked
 * session and comfortably below "I forgot about this overnight".
 *
 * The session itself is never auto-stopped or auto-deleted — see
 * ActiveTimerService for why. This only bounds what a STOP can write.
 */
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * A session whose reconstructed elapsed time is past MAX_SESSION_MS is
 * reported with `isStale: true` so the client can stop rendering a running
 * clock and prompt instead. Same threshold as the cap, kept as its own name
 * because they answer different questions ("should the UI warn?" vs "what is
 * the most we will write?").
 */
export const STALE_AFTER_MS = MAX_SESSION_MS;

/**
 * Hard ceiling on the persisted `accumulatedMs`, which is a Postgres INT
 * (max 2,147,483,647 ≈ 24.8 days). Reaching it requires ~23 days of
 * *running* time across pause cycles, which should never happen — but an
 * overflow here would be a 500 on pause, so it is clamped rather than
 * trusted.
 */
export const MAX_ACCUMULATED_MS = 2_000_000_000;

/** Fallback label when a session is stopped with no name and no attribution. */
export const DEFAULT_TASK_NAME = 'Untitled session';

/** Error code returned in the 409 body when a session already exists. */
export const ACTIVE_SESSION_EXISTS = 'ACTIVE_TIMER_SESSION_EXISTS';

/** Error code returned in the 409 body when a concurrent stop already won. */
export const ACTIVE_SESSION_ALREADY_STOPPED = 'ACTIVE_TIMER_SESSION_ALREADY_STOPPED';
