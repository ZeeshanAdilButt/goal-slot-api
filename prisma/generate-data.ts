// Temporary script to generate data for the database. Will be removed later.

import { GoalStatus, TaskStatus, TimeEntrySource } from '@prisma/client';
import { createPrismaClient } from './create-prisma-client';

const prisma = createPrismaClient();

// Get user email from command line arguments
const userEmail = process.argv[2];

if (!userEmail) {
  console.error('❌ Error: User email is required');
  console.log('Usage: npm run generate-data <user-email>');
  process.exit(1);
}

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
  { title: 'Master React & Next.js', category: 'LEARNING', targetHours: 200, color: '#3B82F6' },
  { title: 'Complete 500 DSA Problems', category: 'WORK', targetHours: 300, color: '#10B981' },
  { title: 'Build SaaS Product', category: 'CREATIVE', targetHours: 150, color: '#EC4899' },
  { title: 'Fitness & Health Goals', category: 'HEALTH', targetHours: 100, color: '#F97316' },
  { title: 'Learn TypeScript Advanced', category: 'LEARNING', targetHours: 80, color: '#8B5CF6' },
  { title: 'Open Source Contributions', category: 'WORK', targetHours: 120, color: '#22C55E' },
  { title: 'Portfolio Website Redesign', category: 'CREATIVE', targetHours: 60, color: '#FACC15' },
  { title: 'Daily Exercise Routine', category: 'HEALTH', targetHours: 180, color: '#EF4444' },
  { title: 'System Design Mastery', category: 'LEARNING', targetHours: 100, color: '#06B6D4' },
  { title: 'Freelance Project Completion', category: 'WORK', targetHours: 200, color: '#6366F1' },
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
  { title: 'Morning DSA Session', startTime: '06:00', endTime: '08:00', dayOfWeek: 1, category: 'DSA' },
  { title: 'Deep Work Block', startTime: '09:00', endTime: '12:00', dayOfWeek: 1, category: 'DEEP_WORK' },
  { title: 'Learning Time', startTime: '14:00', endTime: '16:00', dayOfWeek: 1, category: 'LEARNING' },
  { title: 'Exercise', startTime: '07:00', endTime: '08:00', dayOfWeek: 2, category: 'EXERCISE' },
  { title: 'Side Project', startTime: '18:00', endTime: '20:00', dayOfWeek: 2, category: 'SIDE_PROJECT' },
  { title: 'DSA Practice', startTime: '06:30', endTime: '08:30', dayOfWeek: 3, category: 'DSA' },
  { title: 'Deep Work', startTime: '10:00', endTime: '13:00', dayOfWeek: 3, category: 'DEEP_WORK' },
  { title: 'Team Meeting', startTime: '15:00', endTime: '16:00', dayOfWeek: 4, category: 'MEETING' },
  { title: 'Learning Session', startTime: '14:00', endTime: '16:00', dayOfWeek: 4, category: 'LEARNING' },
  { title: 'Exercise', startTime: '07:00', endTime: '08:00', dayOfWeek: 5, category: 'EXERCISE' },
  { title: 'Side Project Work', startTime: '17:00', endTime: '20:00', dayOfWeek: 5, category: 'SIDE_PROJECT' },
  { title: 'Weekend Learning', startTime: '10:00', endTime: '12:00', dayOfWeek: 6, category: 'LEARNING' },
  { title: 'Weekend Exercise', startTime: '08:00', endTime: '09:00', dayOfWeek: 0, category: 'EXERCISE' },
];

async function main() {
  console.log('🌱 Starting comprehensive data generation...');
  console.log(`📧 Looking for user: ${userEmail}`);

  // Check if user exists
  const user = await prisma.user.findUnique({
    where: { email: userEmail },
  });

  if (!user) {
    console.error(`❌ Error: User with email "${userEmail}" not found`);
    console.log('Please ensure the user exists in the database before running this script.');
    process.exit(1);
  }

  console.log('✅ User found:', user.email);

  // Fetch categories for this user
  let categories = await prisma.category.findMany({
    where: { userId: user.id },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });

  // If user has no categories, seed default categories
  if (categories.length === 0) {
    console.log('📦 No categories found. Seeding default categories...');
    const defaultCategories = [
      // Goal categories
      { name: 'Learning', value: 'LEARNING', color: '#3B82F6', order: 1 },
      { name: 'Work', value: 'WORK', color: '#22D3EE', order: 2 },
      { name: 'Health', value: 'HEALTH', color: '#22C55E', order: 3 },
      { name: 'Creative', value: 'CREATIVE', color: '#EC4899', order: 4 },
      
      // Schedule/Task categories
      { name: 'Deep Work', value: 'DEEP_WORK', color: '#FFD700', order: 5 },
      { name: 'Exercise', value: 'EXERCISE', color: '#F97316', order: 6 },
      { name: 'Side Project', value: 'SIDE_PROJECT', color: '#EC4899', order: 7 },
      { name: 'DSA', value: 'DSA', color: '#FFD700', order: 8 },
      { name: 'Meeting', value: 'MEETING', color: '#8B5CF6', order: 9 },
      { name: 'Admin', value: 'ADMIN', color: '#9CA3AF', order: 10 },
      { name: 'Break', value: 'BREAK', color: '#D1D5DB', order: 11 },
      { name: 'Other', value: 'OTHER', color: '#9CA3AF', order: 12 },
    ];

    await prisma.category.createMany({
      data: defaultCategories.map((cat) => ({
        ...cat,
        userId: user.id,
        isDefault: true,
      })),
    });

    categories = await prisma.category.findMany({
      where: { userId: user.id },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    console.log(`✅ Created ${categories.length} default categories`);
  } else {
    console.log(`✅ Found ${categories.length} existing categories`);
  }

  // Create a map of category values for quick lookup
  const categoryValues = new Set(categories.map(cat => cat.value));
  console.log(`📋 Available categories: ${Array.from(categoryValues).join(', ')}`);

  // Clear existing data for this user
  console.log('🧹 Cleaning existing data...');
  await prisma.timeEntry.deleteMany({ where: { userId: user.id } });
  await prisma.task.deleteMany({ where: { userId: user.id } });
  await prisma.scheduleBlock.deleteMany({ where: { userId: user.id } });
  await prisma.goal.deleteMany({ where: { userId: user.id } });
  console.log('✅ Existing data cleaned');

  // Create Goals - only use templates with valid categories
  console.log('📊 Creating goals...');
  const goals = [];
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);
  
  const validGoalTemplates = goalTemplates.filter(t => categoryValues.has(t.category));
  if (validGoalTemplates.length === 0) {
    console.warn('⚠️  No valid goal templates found (no matching categories). Skipping goals.');
  } else {
    for (let i = 0; i < validGoalTemplates.length; i++) {
      const template = validGoalTemplates[i];
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
          userId: user.id,
        },
      });
      goals.push(goal);
    }
    console.log(`✅ Created ${goals.length} goals`);
  }

  // Create Schedule Blocks - only use templates with valid categories
  console.log('📅 Creating schedule blocks...');
  const scheduleBlocks = [];
  const validScheduleTemplates = scheduleTemplates.filter(t => categoryValues.has(t.category));
  if (validScheduleTemplates.length === 0) {
    console.warn('⚠️  No valid schedule templates found (no matching categories). Skipping schedule blocks.');
  } else {
    for (const template of validScheduleTemplates) {
      const goal = Math.random() > 0.5 ? randomElement(goals.filter(g => g.category && (g.category === 'LEARNING' || g.category === 'WORK'))) : null;
      
      const block = await prisma.scheduleBlock.create({
        data: {
          title: template.title,
          startTime: template.startTime,
          endTime: template.endTime,
          dayOfWeek: template.dayOfWeek,
          category: template.category,
          color: '#FFD700',
          isRecurring: true,
          userId: user.id,
          goalId: goal?.id,
        },
      });
      scheduleBlocks.push(block);
    }
    console.log(`✅ Created ${scheduleBlocks.length} schedule blocks`);
  }

  // Create Tasks - only use templates with valid categories
  console.log('✅ Creating tasks...');
  const tasks = [];
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  const validTaskTemplates = taskTemplates.filter(t => categoryValues.has(t.category));
  if (validTaskTemplates.length === 0) {
    console.warn('⚠️  No valid task templates found (no matching categories). Skipping tasks.');
  } else {
    // Create tasks over the past year
    for (let day = 0; day < 365; day++) {
      const taskDate = addDays(oneYearAgo, day);
      const tasksPerDay = randomInt(0, 5); // 0-5 tasks per day
      
      for (let i = 0; i < tasksPerDay; i++) {
        const template = randomElement(validTaskTemplates);
        const goal = Math.random() > 0.6 ? randomElement(goals) : null;
        const scheduleBlock = Math.random() > 0.7 ? randomElement(scheduleBlocks) : null;
        
        // Determine status based on date
        let status: TaskStatus;
        const daysSinceCreation = Math.floor((Date.now() - taskDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceCreation > 30) {
          status = Math.random() > 0.3 ? TaskStatus.DONE : TaskStatus.BACKLOG;
        } else if (daysSinceCreation > 7) {
          status = randomElement([TaskStatus.DONE, TaskStatus.DOING, TaskStatus.TODO]);
        } else {
          status = randomElement([TaskStatus.DOING, TaskStatus.TODO]);
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
            actualMinutes: status === TaskStatus.DONE ? estimatedMinutes + randomInt(-20, 40) : null,
            completedAt: status === TaskStatus.DONE ? addDays(taskDate, randomInt(0, 7)) : null,
            dueDate: Math.random() > 0.3 ? dueDate : null,
            userId: user.id,
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
  }

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
      const taskName = linkedTask ? linkedTask.title : (validTaskTemplates.length > 0 ? randomElement(validTaskTemplates).title : 'General Task');
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
          userId: user.id,
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
