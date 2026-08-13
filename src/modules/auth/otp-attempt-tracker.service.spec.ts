import { OtpAttemptTrackerService } from './otp-attempt-tracker.service';

describe('OtpAttemptTrackerService', () => {
  it('serializes "concurrent" recordFailedAttempt calls into a gap-free, strictly increasing count', async () => {
    // Regression guard for the non-atomic cacheManager get-then-set bug:
    // every one of these calls must observe a distinct, sequential count.
    // A racy read-modify-write would let several calls read the same
    // starting value and collide on the same count.
    const tracker = new OtpAttemptTrackerService();
    const callCount = 25;

    const results = await Promise.all(
      Array.from({ length: callCount }, () =>
        // Promise.resolve().then(...) queues each call as a separate
        // microtask so they genuinely race to call recordFailedAttempt,
        // rather than running strictly in array order.
        Promise.resolve().then(() =>
          tracker.recordFailedAttempt(
            'racer@example.com',
            'TEST',
            100_000,
            60_000,
            60_000,
          ),
        ),
      ),
    );

    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: callCount }, (_, i) => i + 1));
  });

  it('trips the lockout exactly once when attempts reach the configured max', () => {
    const tracker = new OtpAttemptTrackerService();
    const maxAttempts = 5;

    const outcomes = Array.from({ length: 8 }, () =>
      tracker.recordFailedAttempt(
        'brute@example.com',
        'TEST',
        maxAttempts,
        60_000,
        900_000,
      ),
    );

    const lockedOutOutcomes = outcomes.filter((o) => o.lockedOut);
    expect(lockedOutOutcomes).toHaveLength(1);
    expect(outcomes[maxAttempts - 1].lockedOut).toBe(true);
    expect(tracker.isLockedOut('brute@example.com', 'TEST')).toBe(true);
  });

  it('does not lock out a different email or purpose sharing part of the key', () => {
    const tracker = new OtpAttemptTrackerService();
    for (let i = 0; i < 5; i++) {
      tracker.recordFailedAttempt(
        'victim@example.com',
        'SIGNUP',
        5,
        60_000,
        900_000,
      );
    }
    expect(tracker.isLockedOut('victim@example.com', 'SIGNUP')).toBe(true);
    expect(tracker.isLockedOut('victim@example.com', 'FORGOT_PASSWORD')).toBe(
      false,
    );
    expect(tracker.isLockedOut('other@example.com', 'SIGNUP')).toBe(false);
  });

  it('reset() clears both the attempt count and any active lockout', () => {
    const tracker = new OtpAttemptTrackerService();
    for (let i = 0; i < 5; i++) {
      tracker.recordFailedAttempt(
        'user@example.com',
        'TEST',
        5,
        60_000,
        900_000,
      );
    }
    expect(tracker.isLockedOut('user@example.com', 'TEST')).toBe(true);

    tracker.reset('user@example.com', 'TEST');

    expect(tracker.isLockedOut('user@example.com', 'TEST')).toBe(false);
    // Confirm the attempt counter was cleared too, not just the lockout:
    // a fresh 5 failures should be required to lock out again.
    for (let i = 0; i < 4; i++) {
      const { lockedOut } = tracker.recordFailedAttempt(
        'user@example.com',
        'TEST',
        5,
        60_000,
        900_000,
      );
      expect(lockedOut).toBe(false);
    }
    const { lockedOut } = tracker.recordFailedAttempt(
      'user@example.com',
      'TEST',
      5,
      60_000,
      900_000,
    );
    expect(lockedOut).toBe(true);
  });

  it('expires a lockout after its duration elapses', () => {
    const tracker = new OtpAttemptTrackerService();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000_000);
    for (let i = 0; i < 5; i++) {
      tracker.recordFailedAttempt(
        'user@example.com',
        'TEST',
        5,
        60_000,
        900_000,
      );
    }
    expect(tracker.isLockedOut('user@example.com', 'TEST')).toBe(true);

    nowSpy.mockReturnValue(1_000_000 + 900_000 + 1);
    expect(tracker.isLockedOut('user@example.com', 'TEST')).toBe(false);

    nowSpy.mockRestore();
  });
});
