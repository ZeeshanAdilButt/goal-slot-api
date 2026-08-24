import * as fs from 'fs';
import * as path from 'path';

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
  dailyFocusGoalMinutes: number;
}

// Mirrors the Prisma schema default asserted on further down.
const SCHEMA_DEFAULT_FOCUS_GOAL_MINUTES = 240;

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
      dailyFocusGoalMinutes:
        overrides.dailyFocusGoalMinutes ?? SCHEMA_DEFAULT_FOCUS_GOAL_MINUTES,
    };
    this.users.set(id, user);
    return user;
  }

  user = {
    findUnique: async ({ where }: any) => {
      if (where.id) return this.users.get(where.id) ?? null;
      if (where.email) {
        return (
          [...this.users.values()].find((u) => u.email === where.email) ?? null
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
        dailyFocusGoalMinutes:
          data.dailyFocusGoalMinutes ?? SCHEMA_DEFAULT_FOCUS_GOAL_MINUTES,
      };
      this.users.set(id, row);
      if (!select) return row;
      const out: any = {};
      for (const key of Object.keys(select)) {
        if (select[key]) out[key] = (row as any)[key];
      }
      return out;
    },
    // Mirrors Prisma: keys whose value is `undefined` are left untouched,
    // which is what lets updateProfile pass every optional DTO field through
    // unconditionally.
    update: async ({ where, data }: any) => {
      const row = this.users.get(where.id);
      if (!row) throw new Error('User not found');
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) (row as any)[key] = value;
      }
      return row;
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
        [...prisma.users.values()].some(
          (u) => u.email === 'newsuper@example.com',
        ),
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
        [...prisma.users.values()].some(
          (u) => u.email === 'victim@example.com',
        ),
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

// Per-user daily focus goal.
//
// The Focus Streak card compared against a hardcoded 30-minute constant, so
// anyone tracking real hours cleared it every morning and the streak measured
// nothing. The threshold now lives on the user, defaulting to 4h.

describe('UsersService daily focus goal', () => {
  it('writes a new goal through updateProfile', async () => {
    const { prisma, service } = buildService();
    const user = prisma.seedUser({ role: UserRole.USER });

    const updated = await service.updateProfile(user.id, {
      dailyFocusGoalMinutes: 300,
    });

    expect(updated.dailyFocusGoalMinutes).toBe(300);
    expect(prisma.users.get(user.id)?.dailyFocusGoalMinutes).toBe(300);
  });

  it('accepts a goal below the 240 default -- 240 is a default, not a floor', async () => {
    const { prisma, service } = buildService();
    const user = prisma.seedUser({ role: UserRole.USER });

    const updated = await service.updateProfile(user.id, {
      dailyFocusGoalMinutes: 45,
    });

    expect(updated.dailyFocusGoalMinutes).toBe(45);
  });

  it('leaves the goal alone when the update only touches the name', async () => {
    const { prisma, service } = buildService();
    const user = prisma.seedUser({ role: UserRole.USER });
    await service.updateProfile(user.id, { dailyFocusGoalMinutes: 90 });

    const updated = await service.updateProfile(user.id, { name: 'Renamed' });

    expect(updated.name).toBe('Renamed');
    expect(updated.dailyFocusGoalMinutes).toBe(90);
  });

  it('defaults to 240 minutes in the schema, so existing rows backfill to 4h', () => {
    const schemaPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'prisma',
      'schema.prisma',
    );
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const userModel = schema.slice(
      schema.indexOf('model User {'),
      schema.indexOf('model Goal {'),
    );

    expect(userModel).toMatch(/dailyFocusGoalMinutes\s+Int\s+@default\(240\)/);
  });

  it('ships an additive migration -- new column with a default, no data loss', () => {
    const migrationPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
      '20260824140000_add_daily_focus_goal',
      'migration.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(
      /ALTER TABLE "User" ADD COLUMN "dailyFocusGoalMinutes" INTEGER NOT NULL DEFAULT 240/,
    );
    // Production runs `prisma migrate deploy` on merge; nothing in here may
    // drop or rewrite existing data.
    expect(sql).not.toMatch(/DROP|TRUNCATE|DELETE/i);
  });
});
