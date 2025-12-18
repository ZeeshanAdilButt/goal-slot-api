// Temporary script to generate data for the database. Will be removed later.

import { PrismaClient, GoalCategory, GoalStatus, ScheduleCategory, TaskStatus, TimeEntrySource } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Helper function to get random element from array
function randomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// Helper function to get random number between min and max
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to add days to a date
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Helper function to format time as HH:MM
function formatTime(hours: number, minutes: number = 0): string {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Goal templates
const goalTemplates = [
  { title: 'Master React & Next.js', category: GoalCategory.LEARNING, targetHours: 200, color: '#3B82F6' },
  { title: 'Complete 500 DSA Problems', category: GoalCategory.WORK, targetHours: 300, color: '#10B981' },
  { title: 'Build SaaS Product', category: GoalCategory.CREATIVE, targetHours: 150, color: '#EC4899' },
  { title: 'Fitness & Health Goals', category: GoalCategory.HEALTH, targetHours: 100, color: '#F97316' },
  { title: 'Learn TypeScript Advanced', category: GoalCategory.LEARNING, targetHours: 80, color: '#8B5CF6' },
  { title: 'Open Source Contributions', category: GoalCategory.WORK, targetHours: 120, color: '#22C55E' },
  { title: 'Portfolio Website Redesign', category: GoalCategory.CREATIVE, targetHours: 60, color: '#FACC15' },
  { title: 'Daily Exercise Routine', category: GoalCategory.HEALTH, targetHours: 180, color: '#EF4444' },
  { title: 'System Design Mastery', category: GoalCategory.LEARNING, targetHours: 100, color: '#06B6D4' },
  { title: 'Freelance Project Completion', category: GoalCategory.WORK, targetHours: 200, color: '#6366F1' },
];

// Task templates
const taskTemplates = [
  // Learning tasks
  { title: 'Complete React Hooks tutorial', category: 'LEARNING', estimatedMinutes: 120 },
  { title: 'Build Todo app with Next.js', category: 'LEARNING', estimatedMinutes: 180 },
  { title: 'Read TypeScript handbook chapter', category: 'LEARNING', estimatedMinutes: 60 },
  { title: 'Watch system design video', category: 'LEARNING', estimatedMinutes: 90 },
  { title: 'Practice TypeScript generics', category: 'LEARNING', estimatedMinutes: 45 },
  
  // DSA tasks
  { title: 'Solve Array problems (5)', category: 'DSA', estimatedMinutes: 120 },
  { title: 'Solve Tree problems (3)', category: 'DSA', estimatedMinutes: 150 },
  { title: 'Solve Dynamic Programming (2)', category: 'DSA', estimatedMinutes: 180 },
  { title: 'Review graph algorithms', category: 'DSA', estimatedMinutes: 90 },
  { title: 'LeetCode daily challenge', category: 'DSA', estimatedMinutes: 60 },
  
  // Deep work tasks
  { title: 'Implement authentication system', category: 'DEEP_WORK', estimatedMinutes: 240 },
  { title: 'Design database schema', category: 'DEEP_WORK', estimatedMinutes: 180 },
  { title: 'Refactor legacy code', category: 'DEEP_WORK', estimatedMinutes: 200 },
  { title: 'Write API documentation', category: 'DEEP_WORK', estimatedMinutes: 120 },
  { title: 'Optimize database queries', category: 'DEEP_WORK', estimatedMinutes: 150 },
  
  // Side project tasks
  { title: 'Build landing page', category: 'SIDE_PROJECT', estimatedMinutes: 180 },
  { title: 'Setup CI/CD pipeline', category: 'SIDE_PROJECT', estimatedMinutes: 120 },
  { title: 'Implement payment integration', category: 'SIDE_PROJECT', estimatedMinutes: 240 },
  { title: 'Add analytics dashboard', category: 'SIDE_PROJECT', estimatedMinutes: 200 },
  { title: 'Write unit tests', category: 'SIDE_PROJECT', estimatedMinutes: 150 },
  
  // Exercise tasks
  { title: 'Morning run', category: 'EXERCISE', estimatedMinutes: 30 },
  { title: 'Gym workout', category: 'EXERCISE', estimatedMinutes: 60 },
  { title: 'Yoga session', category: 'EXERCISE', estimatedMinutes: 45 },
  { title: 'Cycling', category: 'EXERCISE', estimatedMinutes: 90 },
  { title: 'Swimming', category: 'EXERCISE', estimatedMinutes: 60 },
  
  // Meeting tasks
  { title: 'Team standup', category: 'MEETING', estimatedMinutes: 30 },
  { title: 'Code review session', category: 'MEETING', estimatedMinutes: 60 },
  { title: 'Sprint planning', category: 'MEETING', estimatedMinutes: 90 },
  { title: 'Client call', category: 'MEETING', estimatedMinutes: 45 },
  { title: 'One-on-one with manager', category: 'MEETING', estimatedMinutes: 30 },
];

// Schedule block templates
const scheduleTemplates = [
  { title: 'Morning DSA Session', startTime: '06:00', endTime: '08:00', dayOfWeek: 1, category: ScheduleCategory.DSA },
  { title: 'Deep Work Block', startTime: '09:00', endTime: '12:00', dayOfWeek: 1, category: ScheduleCategory.DEEP_WORK },
  { title: 'Learning Time', startTime: '14:00', endTime: '16:00', dayOfWeek: 1, category: ScheduleCategory.LEARNING },
  { title: 'Exercise', startTime: '07:00', endTime: '08:00', dayOfWeek: 2, category: ScheduleCategory.EXERCISE },
  { title: 'Side Project', startTime: '18:00', endTime: '20:00', dayOfWeek: 2, category: ScheduleCategory.SIDE_PROJECT },
  { title: 'DSA Practice', startTime: '06:30', endTime: '08:30', dayOfWeek: 3, category: ScheduleCategory.DSA },
  { title: 'Deep Work', startTime: '10:00', endTime: '13:00', dayOfWeek: 3, category: ScheduleCategory.DEEP_WORK },
  { title: 'Team Meeting', startTime: '15:00', endTime: '16:00', dayOfWeek: 4, category: ScheduleCategory.MEETING },
  { title: 'Learning Session', startTime: '14:00', endTime: '16:00', dayOfWeek: 4, category: ScheduleCategory.LEARNING },
  { title: 'Exercise', startTime: '07:00', endTime: '08:00', dayOfWeek: 5, category: ScheduleCategory.EXERCISE },
  { title: 'Side Project Work', startTime: '17:00', endTime: '20:00', dayOfWeek: 5, category: ScheduleCategory.SIDE_PROJECT },
  { title: 'Weekend Learning', startTime: '10:00', endTime: '12:00', dayOfWeek: 6, category: ScheduleCategory.LEARNING },
  { title: 'Weekend Exercise', startTime: '08:00', endTime: '09:00', dayOfWeek: 0, category: ScheduleCategory.EXERCISE },
];

async function main() {
  console.log('🌱 Starting comprehensive data generation...');

  // Get or create a test user
  const testUser = await prisma.user.upsert({
    where: { email: 'test@example.com' },
    update: {},
    create: {
      email: 'test@example.com',
      password: await bcrypt.hash('Test123!', 10),
      name: 'Test User',
      role: 'USER',
      userType: 'EXTERNAL',
      plan: 'PRO',
    },
  });

  console.log('✅ Test user ready:', testUser.email);

  // Clear existing data for this user
  console.log('🧹 Cleaning existing data...');
  await prisma.timeEntry.deleteMany({ where: { userId: testUser.id } });
  await prisma.task.deleteMany({ where: { userId: testUser.id } });
  await prisma.scheduleBlock.deleteMany({ where: { userId: testUser.id } });
  await prisma.goal.deleteMany({ where: { userId: testUser.id } });
  console.log('✅ Existing data cleaned');

  // Create Goals
  console.log('📊 Creating goals...');
  const goals = [];
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);
  
  for (let i = 0; i < goalTemplates.length; i++) {
    const template = goalTemplates[i];
    const deadline = addDays(startDate, randomInt(180, 365));
    const status = i < 2 ? GoalStatus.COMPLETED : i < 5 ? GoalStatus.ACTIVE : GoalStatus.ACTIVE;
    
    const goal = await prisma.goal.create({
      data: {
        title: template.title,
        description: `Goal description for ${template.title}`,
        category: template.category,
        targetHours: template.targetHours,
        loggedHours: 0, // Will be updated by time entries
        deadline,
        status,
        color: template.color,
        userId: testUser.id,
      },
    });
    goals.push(goal);
  }
  console.log(`✅ Created ${goals.length} goals`);

  // Create Schedule Blocks
  console.log('📅 Creating schedule blocks...');
  const scheduleBlocks = [];
  for (const template of scheduleTemplates) {
    const goal = Math.random() > 0.5 ? randomElement(goals.filter(g => g.category === GoalCategory.LEARNING || g.category === GoalCategory.WORK)) : null;
    
    const block = await prisma.scheduleBlock.create({
      data: {
        title: template.title,
        startTime: template.startTime,
        endTime: template.endTime,
        dayOfWeek: template.dayOfWeek,
        category: template.category,
        color: '#FFD700',
        isRecurring: true,
        userId: testUser.id,
        goalId: goal?.id,
      },
    });
    scheduleBlocks.push(block);
  }
  console.log(`✅ Created ${scheduleBlocks.length} schedule blocks`);

  // Create Tasks
  console.log('✅ Creating tasks...');
  const tasks = [];
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  // Create tasks over the past year
  for (let day = 0; day < 365; day++) {
    const taskDate = addDays(oneYearAgo, day);
    const tasksPerDay = randomInt(0, 5); // 0-5 tasks per day
    
    for (let i = 0; i < tasksPerDay; i++) {
      const template = randomElement(taskTemplates);
      const goal = Math.random() > 0.6 ? randomElement(goals) : null;
      const scheduleBlock = Math.random() > 0.7 ? randomElement(scheduleBlocks) : null;
      
      // Determine status based on date
      let status: TaskStatus;
      const daysSinceCreation = Math.floor((Date.now() - taskDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSinceCreation > 30) {
        status = Math.random() > 0.3 ? TaskStatus.COMPLETED : TaskStatus.PENDING;
      } else if (daysSinceCreation > 7) {
        status = randomElement([TaskStatus.COMPLETED, TaskStatus.IN_PROGRESS, TaskStatus.PENDING]);
      } else {
        status = randomElement([TaskStatus.IN_PROGRESS, TaskStatus.PENDING]);
      }
      
      const estimatedMinutes = template.estimatedMinutes + randomInt(-30, 60);
      const dueDate = addDays(taskDate, randomInt(1, 14));
      
      const task = await prisma.task.create({
        data: {
          title: `${template.title} - Day ${day + 1}`,
          description: `Task created on ${taskDate.toISOString().split('T')[0]}`,
          status,
          category: template.category,
          estimatedMinutes,
          actualMinutes: status === TaskStatus.COMPLETED ? estimatedMinutes + randomInt(-20, 40) : null,
          completedAt: status === TaskStatus.COMPLETED ? addDays(taskDate, randomInt(0, 7)) : null,
          dueDate: Math.random() > 0.3 ? dueDate : null,
          userId: testUser.id,
          goalId: goal?.id,
          scheduleBlockId: scheduleBlock?.id,
        },
      });
      tasks.push(task);
    }
    
    if ((day + 1) % 50 === 0) {
      console.log(`  Created tasks for ${day + 1} days...`);
    }
  }
  console.log(`✅ Created ${tasks.length} tasks`);

  // Create Time Entries across the year
  console.log('⏱️  Creating time entries...');
  const timeEntries = [];
  let entryCount = 0;
  
  // Generate time entries for each day of the year
  for (let day = 0; day < 365; day++) {
    const entryDate = addDays(oneYearAgo, day);
    const dayOfWeek = entryDate.getDay();
    
    // More entries on weekdays, fewer on weekends
    const entriesPerDay = dayOfWeek >= 1 && dayOfWeek <= 5 
      ? randomInt(2, 8)  // Weekdays: 2-8 entries
      : randomInt(0, 4);  // Weekends: 0-4 entries
    
    for (let i = 0; i < entriesPerDay; i++) {
      // Select a task (70% chance it's linked to a task)
      const linkedTask = Math.random() > 0.3 ? randomElement(tasks.filter(t => {
        const taskDate = new Date(t.createdAt);
        return taskDate <= entryDate;
      })) : null;
      
      // Select a goal (60% chance)
      const goal = Math.random() > 0.4 ? randomElement(goals) : null;
      
      // Select a schedule block (40% chance, and only if day matches)
      const scheduleBlock = Math.random() > 0.6 
        ? randomElement(scheduleBlocks.filter(b => b.dayOfWeek === dayOfWeek))
        : null;
      
      // Determine duration (15-180 minutes)
      const duration = randomInt(15, 180);
      
      // Determine source (80% TRACKER, 20% COMPLETION)
      const source = Math.random() > 0.2 ? TimeEntrySource.TRACKER : TimeEntrySource.COMPLETION;
      
      // Create time entry
      const taskName = linkedTask ? linkedTask.title : randomElement(taskTemplates).title;
      const startHour = randomInt(6, 20);
      const startMinute = randomInt(0, 59);
      const startedAt = new Date(entryDate);
      startedAt.setHours(startHour, startMinute, 0, 0);
      
      const timeEntry = await prisma.timeEntry.create({
        data: {
          taskName,
          taskTitle: linkedTask?.title,
          duration,
          date: entryDate,
          startedAt,
          dayOfWeek,
          notes: Math.random() > 0.7 ? `Notes for ${taskName}` : null,
          progressPercent: Math.random() > 0.5 ? randomInt(0, 100) : null,
          userId: testUser.id,
          goalId: goal?.id,
          scheduleBlockId: scheduleBlock?.id,
          taskId: linkedTask?.id,
          source,
        },
      });
      
      timeEntries.push(timeEntry);
      entryCount++;
    }
    
    if ((day + 1) % 50 === 0) {
      console.log(`  Created ${entryCount} time entries for ${day + 1} days...`);
    }
  }
  console.log(`✅ Created ${timeEntries.length} time entries`);

  // Update goal loggedHours based on time entries
  console.log('📈 Updating goal progress...');
  for (const goal of goals) {
    const goalEntries = timeEntries.filter(e => e.goalId === goal.id);
    const totalMinutes = goalEntries.reduce((sum, e) => sum + e.duration, 0);
    const loggedHours = totalMinutes / 60;
    
    await prisma.goal.update({
      where: { id: goal.id },
      data: { loggedHours },
    });
  }
  console.log('✅ Goal progress updated');

  // Summary
  console.log('\n🎉 Data generation completed!');
  console.log('📊 Summary:');
  console.log(`   - Goals: ${goals.length}`);
  console.log(`   - Schedule Blocks: ${scheduleBlocks.length}`);
  console.log(`   - Tasks: ${tasks.length}`);
  console.log(`   - Time Entries: ${timeEntries.length}`);
  console.log(`   - Total hours logged: ${(timeEntries.reduce((sum, e) => sum + e.duration, 0) / 60).toFixed(2)}`);
}

main()
  .catch((e) => {
    console.error('❌ Data generation failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
