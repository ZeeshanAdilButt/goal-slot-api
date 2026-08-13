import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PushSubscriptionsService } from './push-subscriptions.service';

class FakePrisma {
  rows: any[] = [];
  private nextId = 1;

  pushSubscription = {
    upsert: async ({ where, create, update }: any) => {
      let existing: any;
      if (where.userId_endpoint) {
        existing = this.rows.find(
          (r) =>
            r.userId === where.userId_endpoint.userId &&
            r.endpoint === where.userId_endpoint.endpoint,
        );
      } else if (where.userId_expoToken) {
        existing = this.rows.find(
          (r) =>
            r.userId === where.userId_expoToken.userId &&
            r.expoToken === where.userId_expoToken.expoToken,
        );
      }

      if (existing) {
        Object.assign(existing, update);
        return existing;
      }

      const row = {
        id: `ps_${this.nextId++}`,
        endpoint: null,
        p256dh: null,
        auth: null,
        expoToken: null,
        ...create,
      };
      this.rows.push(row);
      return row;
    },
    findUnique: async ({ where }: any) =>
      this.rows.find((r) => r.id === where.id) ?? null,
    delete: async ({ where }: any) => {
      const index = this.rows.findIndex((r) => r.id === where.id);
      const [removed] = this.rows.splice(index, 1);
      return removed;
    },
    deleteMany: async ({ where }: any) => {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => {
        if (r.userId !== where.userId) return true;
        if ('endpoint' in where) return r.endpoint !== where.endpoint;
        if ('expoToken' in where) return r.expoToken !== where.expoToken;
        return true;
      });
      return { count: before - this.rows.length };
    },
  };
}

function buildService() {
  const prisma = new FakePrisma();
  const service = new PushSubscriptionsService(prisma as any);
  return { prisma, service };
}

describe('PushSubscriptionsService', () => {
  describe('register', () => {
    it('creates a WEB row when endpoint, p256dh, and auth are provided', async () => {
      const { prisma, service } = buildService();

      const result = await service.register('user_1', {
        endpoint: 'https://push.example/abc',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      });

      expect(result.kind).toBe('WEB');
      expect(result.endpoint).toBe('https://push.example/abc');
      expect(prisma.rows).toHaveLength(1);
    });

    it('creates an EXPO row when only expoToken is provided', async () => {
      const { prisma, service } = buildService();

      const result = await service.register('user_1', {
        expoToken: 'ExponentPushToken[abc]',
      });

      expect(result.kind).toBe('EXPO');
      expect(result.expoToken).toBe('ExponentPushToken[abc]');
      expect(prisma.rows).toHaveLength(1);
    });

    it('rejects a payload that mixes web and Expo fields', async () => {
      const { service } = buildService();

      await expect(
        service.register('user_1', {
          endpoint: 'https://push.example/abc',
          p256dh: 'p256dh-key',
          auth: 'auth-secret',
          expoToken: 'ExponentPushToken[abc]',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a payload with neither shape', async () => {
      const { service } = buildService();

      await expect(service.register('user_1', {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an incomplete web push shape', async () => {
      const { service } = buildService();

      await expect(
        service.register('user_1', { endpoint: 'https://push.example/abc' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('upserts in place when the same user registers the same endpoint again', async () => {
      const { prisma, service } = buildService();

      await service.register('user_1', {
        endpoint: 'https://push.example/abc',
        p256dh: 'old-key',
        auth: 'old-secret',
      });
      await service.register('user_1', {
        endpoint: 'https://push.example/abc',
        p256dh: 'new-key',
        auth: 'new-secret',
      });

      expect(prisma.rows).toHaveLength(1);
      expect(prisma.rows[0].p256dh).toBe('new-key');
    });
  });

  describe('unregister', () => {
    it('deletes the row when the caller owns it', async () => {
      const { prisma, service } = buildService();
      const created = await service.register('user_1', {
        expoToken: 'ExponentPushToken[abc]',
      });

      await service.unregister(created.id, 'user_1');

      expect(prisma.rows).toHaveLength(0);
    });

    it('throws ForbiddenException when the caller does not own the row', async () => {
      const { prisma, service } = buildService();
      const created = await service.register('user_1', {
        expoToken: 'ExponentPushToken[abc]',
      });

      await expect(service.unregister(created.id, 'user_2')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.rows).toHaveLength(1);
    });

    it('throws NotFoundException when the row does not exist', async () => {
      const { service } = buildService();

      await expect(service.unregister('missing-id', 'user_1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteByEndpoint / deleteByExpoToken', () => {
    it('removes only the matching WEB subscription', async () => {
      const { prisma, service } = buildService();
      await service.register('user_1', {
        endpoint: 'https://push.example/1',
        p256dh: 'p',
        auth: 'a',
      });
      await service.register('user_1', {
        endpoint: 'https://push.example/2',
        p256dh: 'p',
        auth: 'a',
      });

      await service.deleteByEndpoint('user_1', 'https://push.example/1');

      expect(prisma.rows).toHaveLength(1);
      expect(prisma.rows[0].endpoint).toBe('https://push.example/2');
    });

    it('removes only the matching EXPO subscription', async () => {
      const { prisma, service } = buildService();
      await service.register('user_1', { expoToken: 'token-1' });
      await service.register('user_1', { expoToken: 'token-2' });

      await service.deleteByExpoToken('user_1', 'token-1');

      expect(prisma.rows).toHaveLength(1);
      expect(prisma.rows[0].expoToken).toBe('token-2');
    });
  });
});
