// Temporary script to update the user ID in the database. Will be removed later.

import { createPrismaClient } from './create-prisma-client';

const prisma = createPrismaClient();

const TARGET_USER_ID = 'c01ee0ef-569c-41ab-bf67-22773bc0c396';

async function main() {
  console.log('🔄 Starting user ID update...');

  // First, verify the user exists
  const user = await prisma.user.findUnique({
    where: { id: TARGET_USER_ID },
  });

  if (!user) {
    console.error(`❌ User not found!`);
    console.error('Please ensure the user exists before running this script.');
    process.exit(1);
  }


  // Get counts before update
  const goalsCount = await prisma.goal.count();
  const tasksCount = await prisma.task.count();
  const scheduleBlocksCount = await prisma.scheduleBlock.count();
  const timeEntriesCount = await prisma.timeEntry.count();

  console.log('\n📊 Current data counts:');
  console.log(`   - Goals: ${goalsCount}`);
  console.log(`   - Tasks: ${tasksCount}`);
  console.log(`   - Schedule Blocks: ${scheduleBlocksCount}`);
  console.log(`   - Time Entries: ${timeEntriesCount}`);

  // Update Goals
  console.log('\n🔄 Updating Goals...');
  const goalsResult = await prisma.goal.updateMany({
    data: {
      userId: TARGET_USER_ID,
    },
  });
  console.log(`✅ Updated ${goalsResult.count} goals`);

  // Update Tasks
  console.log('🔄 Updating Tasks...');
  const tasksResult = await prisma.task.updateMany({
    data: {
      userId: TARGET_USER_ID,
    },
  });
  console.log(`✅ Updated ${tasksResult.count} tasks`);

  // Update Schedule Blocks
  console.log('🔄 Updating Schedule Blocks...');
  const scheduleBlocksResult = await prisma.scheduleBlock.updateMany({
    data: {
      userId: TARGET_USER_ID,
    },
  });
  console.log(`✅ Updated ${scheduleBlocksResult.count} schedule blocks`);

  // Update Time Entries
  console.log('🔄 Updating Time Entries...');
  const timeEntriesResult = await prisma.timeEntry.updateMany({
    data: {
      userId: TARGET_USER_ID,
    },
  });
  console.log(`✅ Updated ${timeEntriesResult.count} time entries`);

  // Verify the update
  console.log('\n🔍 Verifying updates...');
  const goalsForUser = await prisma.goal.count({
    where: { userId: TARGET_USER_ID },
  });
  const tasksForUser = await prisma.task.count({
    where: { userId: TARGET_USER_ID },
  });
  const scheduleBlocksForUser = await prisma.scheduleBlock.count({
    where: { userId: TARGET_USER_ID },
  });
  const timeEntriesForUser = await prisma.timeEntry.count({
    where: { userId: TARGET_USER_ID },
  });

  console.log('\n📊 Final counts for target user:');
  console.log(`   - Goals: ${goalsForUser}`);
  console.log(`   - Tasks: ${tasksForUser}`);
  console.log(`   - Schedule Blocks: ${scheduleBlocksForUser}`);
  console.log(`   - Time Entries: ${timeEntriesForUser}`);

  // Check if there are any remaining records with different userId
  const otherGoals = await prisma.goal.count({
    where: {
      userId: { not: TARGET_USER_ID },
    },
  });
  const otherTasks = await prisma.task.count({
    where: {
      userId: { not: TARGET_USER_ID },
    },
  });
  const otherScheduleBlocks = await prisma.scheduleBlock.count({
    where: {
      userId: { not: TARGET_USER_ID },
    },
  });
  const otherTimeEntries = await prisma.timeEntry.count({
    where: {
      userId: { not: TARGET_USER_ID },
    },
  });

  if (otherGoals > 0 || otherTasks > 0 || otherScheduleBlocks > 0 || otherTimeEntries > 0) {
    console.log('\n⚠️  Warning: Some records still have different userId:');
    if (otherGoals > 0) console.log(`   - Goals: ${otherGoals}`);
    if (otherTasks > 0) console.log(`   - Tasks: ${otherTasks}`);
    if (otherScheduleBlocks > 0) console.log(`   - Schedule Blocks: ${otherScheduleBlocks}`);
    if (otherTimeEntries > 0) console.log(`   - Time Entries: ${otherTimeEntries}`);
  } else {
    console.log('\n✅ All records successfully updated to target user ID!');
  }

  console.log('\n🎉 User ID update completed!');
}

main()
  .catch((e) => {
    console.error('❌ Update failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
