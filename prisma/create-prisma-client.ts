import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Load environment variables from .env file for CLI scripts
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

type CreatePrismaClientOptions = {
  accelerateUrl?: string;
};

export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  const accelerateUrl = options.accelerateUrl?.trim();

  if (accelerateUrl) {
    return new PrismaClient({ accelerateUrl });
  }

  if (!connectionString) {
    throw new Error('Missing DATABASE_URL. Provide DATABASE_URL or pass accelerateUrl to createPrismaClient().');
  }

  const clientOptions: Prisma.PrismaClientOptions = {
    adapter: new PrismaPg({ connectionString }),
  };
  return new PrismaClient(clientOptions);
}
