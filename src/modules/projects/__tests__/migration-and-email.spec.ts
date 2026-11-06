import * as fs from 'fs';
import * as path from 'path';
import { EmailService } from '../../email/email.service';

describe('add_projects migration', () => {
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
      '20261106120000_add_projects',
      'migration.sql',
    ),
    'utf8',
  );

  // Production runs `prisma migrate deploy` after merge; nothing here may
  // drop, rewrite or backfill existing data.
  it('is purely additive', () => {
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|DELETE FROM|^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });

  it('adds Task.projectId and Task.assigneeId as nullable columns', () => {
    expect(sql).toMatch(/ADD COLUMN\s+"assigneeId" TEXT,/);
    expect(sql).toMatch(/ADD COLUMN\s+"projectId" TEXT;/);
    expect(sql).not.toMatch(
      /"(projectId|assigneeId)" TEXT NOT NULL,\s*\n\s*ADD/,
    );
  });

  it('creates the enum, the three tables and the task foreign keys', () => {
    expect(sql).toContain(
      `CREATE TYPE "ProjectRole" AS ENUM ('ADMIN', 'MEMBER', 'GUEST')`,
    );
    for (const table of ['Project', 'ProjectMember', 'ProjectInvite']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toMatch(/"Task_projectId_fkey".*ON DELETE CASCADE/);
    expect(sql).toMatch(/"Task_assigneeId_fkey".*ON DELETE SET NULL/);
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key"',
    );
    expect(sql).toContain('CREATE UNIQUE INDEX "ProjectInvite_token_key"');
  });

  it('sorts after every existing migration', () => {
    const dir = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
    );
    const names = fs
      .readdirSync(dir)
      .filter((n) => /^\d{14}_/.test(n))
      .sort();
    expect(names.at(-1)).toBe('20261106120000_add_projects');
  });
});

describe('EmailService.sendProjectInvitation', () => {
  function build() {
    const config = {
      getOrThrow: (key: string) =>
        ({
          RESEND_API_KEY: 're_test',
          APP_URL: 'https://app.goalslot.io',
          ONBOARDING_EMAIL: 'onboarding@goalslot.io',
          NOTIFICATION_EMAIL: 'notify@goalslot.io',
        })[key],
    };
    const service = new EmailService(config as any);
    const send = jest
      .fn()
      .mockResolvedValue({ data: { id: 'e1' }, error: null });
    (service as any).resend = { emails: { send } };
    return { service, send };
  }

  it('links to the web accept page with the token', async () => {
    const { service, send } = build();
    await service.sendProjectInvitation({
      toEmail: 'new@example.com',
      inviterName: 'Ada',
      inviterEmail: 'ada@example.com',
      projectName: 'Launch',
      role: 'MEMBER',
      inviteToken: 'tok_abc-123',
    });

    const { html, text, to } = send.mock.calls[0][0];
    expect(to).toBe('new@example.com');
    expect(html).toContain(
      'https://app.goalslot.io/projects/invite?token=tok_abc-123',
    );
    expect(text).toContain(
      'https://app.goalslot.io/projects/invite?token=tok_abc-123',
    );
  });

  it('escapes user-controlled names in the html and subject', async () => {
    const { service, send } = build();
    await service.sendProjectInvitation({
      toEmail: 'victim@example.com',
      inviterName: 'GoalSlot Security<a href="https://evil.tld">Verify</a>',
      inviterEmail: 'attacker@example.com',
      projectName: '<script>alert(1)</script>',
      role: 'ADMIN',
      inviteToken: 't',
    });

    const { html, subject } = send.mock.calls[0][0];
    for (const value of [html, subject]) {
      expect(value).not.toContain('<a href="https://evil.tld"');
      expect(value).not.toContain('<script>');
    }
    expect(html).toContain('&lt;script&gt;');
  });

  it('throws when Resend reports an error, so the caller can mark emailSent false', async () => {
    const { service, send } = build();
    send.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(
      service.sendProjectInvitation({
        toEmail: 'x@example.com',
        inviterName: 'A',
        inviterEmail: 'a@example.com',
        projectName: 'P',
        role: 'GUEST',
        inviteToken: 't',
      }),
    ).rejects.toThrow(/project invitation/);
  });
});
