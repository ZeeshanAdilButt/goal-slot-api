import { UserRole, UserType, PlanType, GoalStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createPrismaClient } from './create-prisma-client';

const prisma = createPrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create Super Admin
  const superAdminPassword = 'SuperAdmin123!';
  const hashedPassword = await bcrypt.hash(superAdminPassword, 10);

  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@devweekends.com' },
    update: {
      password: hashedPassword,
      name: 'Admin',
      role: UserRole.SUPER_ADMIN,
      userType: UserType.INTERNAL,
      plan: PlanType.PRO,
      unlimitedAccess: true,
    },
    create: {
      email: 'admin@devweekends.com',
      password: hashedPassword,
      name: 'Admin',
      role: UserRole.SUPER_ADMIN,
      userType: UserType.INTERNAL,
      plan: PlanType.PRO,
      unlimitedAccess: true,
    },
  });

  console.log('✅ Super Admin created:', superAdmin.email);

  // Create sample internal user
  const internalUser = await prisma.user.upsert({
    where: { email: 'mentor@devweekends.com' },
    update: {},
    create: {
      email: 'mentor@devweekends.com',
      password: await bcrypt.hash('Mentor2025!', 10),
      name: 'Mentor',
      role: UserRole.USER,
      userType: UserType.INTERNAL,
      plan: PlanType.PRO,
      unlimitedAccess: true,
    },
  });

  console.log('✅ Internal user created:', internalUser.email);

  // Create sample goals for the internal user
  const goalsData = [
    {
      title: 'Open Source',
      description: 'GSoC readiness',
      category: 'LEARNING',
      targetHours: 120,
      loggedHours: 0,
      deadline: new Date('2025-12-31'),
      status: GoalStatus.ACTIVE,
      color: '#22C55E',
      userId: internalUser.id,
    },
    {
      title: '200 DSA',
      description: 'Complete 200 DSA problems',
      category: 'WORK',
      targetHours: 90,
      loggedHours: 1,
      deadline: new Date('2025-12-31'),
      status: GoalStatus.ACTIVE,
      color: '#3B82F6',
      userId: internalUser.id,
    },
    {
      title: 'Learn React',
      description: 'Complete React course and build 3 projects',
      category: 'LEARNING',
      targetHours: 40,
      loggedHours: 1,
      deadline: new Date('2025-02-28'),
      status: GoalStatus.ACTIVE,
      color: '#3B82F6',
      userId: internalUser.id,
    },
    {
      title: 'Fitness Goals',
      description: 'Workout 5 times a week',
      category: 'HEALTH',
      targetHours: 20,
      loggedHours: 0,
      deadline: new Date('2025-01-31'),
      status: GoalStatus.ACTIVE,
      color: '#22C55E',
      userId: internalUser.id,
    },
    {
      title: 'Multi Vendor',
      description: 'Build and launch my SaaS product',
      category: 'CREATIVE',
      targetHours: 60,
      loggedHours: 0,
      deadline: new Date('2025-03-15'),
      status: GoalStatus.ACTIVE,
      color: '#EC4899',
      userId: internalUser.id,
    },
  ];

  await prisma.goal.createMany({
    data: goalsData,
  });

  const goals = await prisma.goal.findMany({
    where: { userId: internalUser.id },
    orderBy: { createdAt: 'desc' },
    take: goalsData.length,
  });

  console.log('✅ Sample goals created:', goals.length);

  // Create sample schedule blocks
  const scheduleBlocksData = [
    {
      title: 'DSA',
      startTime: '06:00',
      endTime: '09:00',
      dayOfWeek: 1, // Monday
      category: 'DSA',
      color: '#FFD700',
      userId: internalUser.id,
    },
    {
      title: 'Deep Work',
      startTime: '09:00',
      endTime: '12:00',
      dayOfWeek: 1, // Monday
      category: 'DEEP_WORK',
      color: '#FFD700',
      userId: internalUser.id,
    },
    {
      title: 'Exercise',
      startTime: '07:00',
      endTime: '08:00',
      dayOfWeek: 3, // Wednesday
      category: 'EXERCISE',
      color: '#F97316',
      userId: internalUser.id,
    },
    {
      title: 'Learning',
      startTime: '14:00',
      endTime: '16:00',
      dayOfWeek: 2, // Tuesday
      category: 'LEARNING',
      color: '#22C55E',
      userId: internalUser.id,
    },
    {
      title: 'Side Project',
      startTime: '17:00',
      endTime: '20:00',
      dayOfWeek: 5, // Friday
      category: 'SIDE_PROJECT',
      color: '#EC4899',
      userId: internalUser.id,
    },
  ];

  await prisma.scheduleBlock.createMany({
    data: scheduleBlocksData,
  });

  const scheduleBlocks = await prisma.scheduleBlock.findMany({
    where: { userId: internalUser.id },
    orderBy: { createdAt: 'desc' },
    take: scheduleBlocksData.length,
  });

  console.log('✅ Sample schedule blocks created:', scheduleBlocks.length);

  console.log('🎉 Database seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
