import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterPushSubscriptionDto } from './push-subscriptions.dto';

// Exercises the same class-validator decorators the global ValidationPipe
// runs against every POST /push-subscriptions body (see main.ts). A
// non-empty errors array here is exactly what turns into a 400 at the
// controller boundary - these tests are the SSRF fix from the security
// review: the endpoint must be an https URL on a known push-service host,
// not an arbitrary attacker-chosen origin (see push-subscriptions.dto.ts).
describe('RegisterPushSubscriptionDto', () => {
  async function validateDto(payload: Partial<RegisterPushSubscriptionDto>) {
    const dto = plainToInstance(RegisterPushSubscriptionDto, payload);
    return validate(dto);
  }

  describe('endpoint allowlist', () => {
    it('rejects an internal/link-local host such as the cloud metadata endpoint', async () => {
      const errors = await validateDto({
        endpoint: 'https://169.254.169.254/latest/meta-data/',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(errors).not.toHaveLength(0);
      expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
    });

    it('rejects an arbitrary attacker-chosen https host', async () => {
      const errors = await validateDto({
        endpoint: 'https://attacker.example/collect',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(errors).not.toHaveLength(0);
      expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
    });

    it('rejects a non-https scheme even on an allowlisted host', async () => {
      const errors = await validateDto({
        endpoint: 'http://fcm.googleapis.com/fcm/send/abc',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(errors).not.toHaveLength(0);
      expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
    });

    it('rejects a malformed URL', async () => {
      const errors = await validateDto({
        endpoint: 'not-a-url',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(errors).not.toHaveLength(0);
      expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
    });

    it('accepts a real FCM (Chrome) endpoint', async () => {
      const errors = await validateDto({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(errors.filter((e) => e.property === 'endpoint')).toHaveLength(0);
    });

    it('accepts a real Mozilla autopush endpoint', async () => {
      const errors = await validateDto({
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc123',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(errors.filter((e) => e.property === 'endpoint')).toHaveLength(0);
    });

    it('accepts a real Apple web push endpoint', async () => {
      const errors = await validateDto({
        endpoint: 'https://web.push.apple.com/abc123',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(errors.filter((e) => e.property === 'endpoint')).toHaveLength(0);
    });

    it('does not require endpoint to be present at all (Expo-only registration)', async () => {
      const errors = await validateDto({ expoToken: 'ExponentPushToken[abc]' });

      expect(errors.filter((e) => e.property === 'endpoint')).toHaveLength(0);
    });
  });
});
