import { Prisma, PrismaClient } from '@prisma/client';

type PrismaPgConstructor = new (opts: { connectionString: string }) => NonNullable<Prisma.PrismaClientOptions['adapter']>;

export function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return new PrismaClient();

  try {
    const { PrismaPg } = require('@prisma/adapter-pg') as { PrismaPg: PrismaPgConstructor };
    const options: Prisma.PrismaClientOptions = {
      adapter: new PrismaPg({ connectionString }),
    };
    return new PrismaClient(options);
  } catch {
    return new PrismaClient();
  }
}
