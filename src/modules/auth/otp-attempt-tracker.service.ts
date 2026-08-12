import { Injectable } from '@nestjs/common';

interface AttemptEntry {
  count: number;
  expiresAt: number; // ms epoch; entry is stale once we pass this
}

/**
 * Dedicated, unbounded, in-memory store for OTP verification attempt counts
 * and lockouts.
 *
 * This is intentionally separate from the shared CacheModule LRU cache
 * (see AuthModule, `CacheModule.register({ ttl: 300, max: 1000 })`) that
 * backs OTP codes, resend cooldowns and request rate limits. Reusing that
 * cache for lockout state had two problems:
 *
 *  - it is capped at `max: 1000` entries, so unrelated traffic (e.g. a
 *    flood of /send-otp calls against junk emails) evicts older keys via
 *    LRU, including a victim's `otp:lockout:*` / `otp:attempts:*` entries,
 *    silently resetting their attempt counter.
 *  - the old get-then-set against that cache was two separate awaited
 *    calls, so concurrent verification attempts could race: both requests
 *    read the same starting count before either wrote back, under-counting
 *    failed attempts and letting a brute-force loop blow past the cap.
 *
 * A plain in-process Map with synchronous (non-awaiting) read-modify-write
 * methods fixes both: there is no size cap to evict from, and because these
 * methods never `await` between reading and writing, two "concurrent"
 * callers can never interleave mid-update — each call runs to completion
 * before the event loop can start the next one.
 */
@Injectable()
export class OtpAttemptTrackerService {
  private readonly attempts = new Map<string, AttemptEntry>();
  private readonly lockouts = new Map<string, number>(); // key -> lockedUntil epoch ms

  private key(email: string, purpose: string): string {
    return `${purpose}:${email.trim().toLowerCase()}`;
  }

  isLockedOut(email: string, purpose: string): boolean {
    const key = this.key(email, purpose);
    const lockedUntil = this.lockouts.get(key);
    if (lockedUntil === undefined) {
      return false;
    }
    if (Date.now() >= lockedUntil) {
      this.lockouts.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Records a failed verification attempt and reports whether this attempt
   * pushed the count to (or past) the lockout threshold. The whole
   * read-modify-write happens synchronously against the Map, so concurrent
   * callers cannot race each other into under-counting.
   */
  recordFailedAttempt(
    email: string,
    purpose: string,
    maxAttempts: number,
    attemptWindowMs: number,
    lockoutDurationMs: number,
  ): { lockedOut: boolean; count: number } {
    const key = this.key(email, purpose);
    const now = Date.now();

    const existing = this.attempts.get(key);
    const count = existing && existing.expiresAt > now ? existing.count + 1 : 1;
    this.attempts.set(key, { count, expiresAt: now + attemptWindowMs });

    if (count >= maxAttempts) {
      this.lockouts.set(key, now + lockoutDurationMs);
      this.attempts.delete(key);
      return { lockedOut: true, count };
    }

    return { lockedOut: false, count };
  }

  reset(email: string, purpose: string): void {
    const key = this.key(email, purpose);
    this.attempts.delete(key);
    this.lockouts.delete(key);
  }
}
