import { ForbiddenException } from '@nestjs/common';
import { UserRole, UserType, PlanType } from '@prisma/client';

import { UsersService } from './users.service';

// ---------- Fakes ----------

interface FakeUser {
  id: string;
  email: string;
  password: string;
  name: string;
  role: UserRole;
  userType: UserType;
  plan: PlanType;
  unlimitedAccess: boolean;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
}

class FakePrisma {
  private seq = 0;
  users = new Map<string, FakeUser>();

  seedUser(overrides: Partial<FakeUser> & { role: UserRole }): FakeUser {
    const id = `seed_${++this.seq}`;
    const user: FakeUser = {
      id,
      email: overrides.email ?? `${id}@example.com`,
      password: 'hashed',
      name: overrides.name ?? 'Seed User',
      role: overrides.role,
      userType: overrides.userType ?? UserType.EXTERNAL,
      plan: overrides.plan ?? PlanType.FREE,
      unlimitedAccess: overrides.unlimitedAccess ?? false,
      emailVerified: overrides.emailVerified ?? true,
      emailVerifiedAt: overrides.emailVerifiedAt ?? new Date(),
    };
    this.users.set(id, user);
    return user;
  }

  user = {
    findUnique: async ({ where }: any) => {
      if (where.id) return this.users.get(where.id) ?? null;
      if (where.email) {
        return (
          [...this.users.values()].find((u) => u.email === where.email) ??
          null
        );
      }
      return null;
    },
    findMany: async ({ where }: any) => {
      const emails: string[] = where?.email?.in ?? [];
      return [...this.users.values()]
        .filter((u) => emails.includes(u.email))
        .map((u) => ({ email: u.email }));
    },
    create: async ({ data, select }: any) => {
      const id = `user_${++this.seq}`;
      const row: FakeUser = {
        id,
        email: data.email,
        password: data.password,
        name: data.name,
        role: data.role,
        userType: data.userType,
        plan: data.plan,
        unlimitedAccess: !!data.unlimitedAccess,
        emailVerified: !!data.emailVerified,
        emailVerifiedAt: data.emailVerifiedAt ?? null,
      };
      this.users.set(id, row);
      if (!select) return row;
      const out: any = {};
      for (const key of Object.keys(select)) {
        if (select[key]) out[key] = (row as any)[key];
      }
      return out;
    },
  };
}

class FakeEmailService {
  sent: any[] = [];
  async sendBulkInviteWelcome(params: any) {
    this.sent.push(params);
    return { success: true, id: 'email_1' };
  }
}

function buildService() {
  const prisma = new FakePrisma();
  const emailService = new FakeEmailService();
  const service = new UsersService(prisma as any, emailService as any);
  return { prisma, emailService, service };
}

describe('UsersService role-escalation guard', () => {
  describe('createInternalUser', () => {
    it('rejects an ADMIN caller trying to mint a SUPER_ADMIN account', async () => {
      const { prisma, service } = buildService();
      const admin = prisma.seedUser({ role: UserRole.ADMIN });

      await expect(
        service.createInternalUser(admin.id, {
          email: 'newsuper@example.com',
          password: 'SecurePassword123!',
          name: 'Sneaky Admin',
          role: UserRole.SUPER_ADMIN,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(
        [...prisma.users.values()].some((u) => u.email === 'newsuper@example.com'),
      ).toBe(false);
    });

    it('allows a SUPER_ADMIN caller to create another SUPER_ADMIN', async () => {
      const { prisma, service } = buildService();
      const superAdmin = prisma.seedUser({ role: UserRole.SUPER_ADMIN });

      const created = await service.createInternalUser(superAdmin.id, {
        email: 'newsuper@example.com',
        password: 'SecurePassword123!',
        name: 'Legit Super Admin',
        role: UserRole.SUPER_ADMIN,
      });

      expect(created.role).toBe(UserRole.SUPER_ADMIN);
    });

    it('still allows an ADMIN caller to create a plain USER or ADMIN account', async () => {
      const { prisma, service } = buildService();
      const admin = prisma.seedUser({ role: UserRole.ADMIN });

      const created = await service.createInternalUser(admin.id, {
        email: 'newadmin@example.com',
        password: 'SecurePassword123!',
        name: 'New Admin',
        role: UserRole.ADMIN,
      });

      expect(created.role).toBe(UserRole.ADMIN);
    });
  });

  describe('bulkInvite', () => {
    it('rejects an ADMIN caller trying to bulk-invite at SUPER_ADMIN role', async () => {
      const { prisma, service, emailService } = buildService();
      const admin = prisma.seedUser({ role: UserRole.ADMIN });

      await expect(
        service.bulkInvite(admin.id, {
          text: 'victim@example.com',
          role: UserRole.SUPER_ADMIN,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(
        [...prisma.users.values()].some((u) => u.email === 'victim@example.com'),
      ).toBe(false);
      expect(emailService.sent).toHaveLength(0);
    });

    it('allows a SUPER_ADMIN caller to bulk-invite at SUPER_ADMIN role', async () => {
      const { prisma, service } = buildService();
      const superAdmin = prisma.seedUser({ role: UserRole.SUPER_ADMIN });

      const result = await service.bulkInvite(superAdmin.id, {
        text: 'victim@example.com',
        role: UserRole.SUPER_ADMIN,
      });

      expect(result.invited).toBe(1);
      const created = [...prisma.users.values()].find(
        (u) => u.email === 'victim@example.com',
      );
      expect(created?.role).toBe(UserRole.SUPER_ADMIN);
    });

    it('still allows an ADMIN caller to bulk-invite at the default USER role', async () => {
      const { prisma, service } = buildService();
      const admin = prisma.seedUser({ role: UserRole.ADMIN });

      const result = await service.bulkInvite(admin.id, {
        text: 'member@example.com',
      });

      expect(result.invited).toBe(1);
      const created = [...prisma.users.values()].find(
        (u) => u.email === 'member@example.com',
      );
      expect(created?.role).toBe(UserRole.USER);
    });
  });
});
