// One-off diagnostic for the "schedule still double" report investigated
// 2026-08-16. The root cause (a check-then-insert race in ScheduleService.create)
// was fixed in commit 2ef3100 and its concurrency guarantee genuinely proven
// in 759e3e2 — that fix is server-side and has been live in production since
// 2026-08-16T06:56:23Z. It does NOT retroactively remove rows that were
// already duplicated before it shipped, which is the leading explanation for
// why duplicates are still visible on at least one account.
//
// This script only REPORTS candidates. It never deletes anything — read the
// output, confirm by eye that a group really is a duplicate (not two
// legitimately different blocks that happen to share a title), and remove
// the unwanted row(s) by hand (or extend this script deliberately, later,
// once you've decided on a real policy — e.g. "keep the earliest" isn't
// always right if a LATER row is the one with real TimeEntries attached).
//
// Usage: npx ts-node scripts/find-duplicate-schedule-blocks.ts
// Or narrow to one account while investigating: pass a userId as argv[2].

import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const targetUserId = process.argv[2];

  try {
    const blocks = await prisma.scheduleBlock.findMany({
      where: targetUserId ? { userId: targetUserId } : undefined,
      select: {
        id: true,
        userId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        title: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const groups = new Map<string, typeof blocks>();
    for (const block of blocks) {
      const key = [
        block.userId,
        block.dayOfWeek,
        block.startTime,
        block.endTime,
        block.title,
      ].join('|');
      const group = groups.get(key) ?? [];
      group.push(block);
      groups.set(key, group);
    }

    // The fix deployed at this instant — anything created before it is an
    // expected pre-fix leftover; anything at/after it would be new evidence
    // the fix isn't actually holding and would need re-investigating.
    const fixDeployedAt = new Date('2026-08-16T06:56:23Z');

    const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

    if (duplicateGroups.length === 0) {
      console.log('No duplicate schedule blocks found.');
      return;
    }

    console.log(`Found ${duplicateGroups.length} duplicate group(s):\n`);
    for (const group of duplicateGroups) {
      const [first] = group;
      console.log(
        `user=${first.userId} day=${first.dayOfWeek} ${first.startTime}-${first.endTime} "${first.title}" — ${group.length} rows:`,
      );
      for (const row of group) {
        const isPreFix = row.createdAt < fixDeployedAt;
        console.log(
          `  id=${row.id}  createdAt=${row.createdAt.toISOString()}  ${isPreFix ? '(pre-fix leftover, expected)' : '(!! at/after the fix deploy — unexpected, worth re-investigating)'}`,
        );
      }
      console.log('');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
