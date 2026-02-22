import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super(PrismaService.buildClientOptions());
  }

  private static buildClientOptions(): Prisma.PrismaClientOptions {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'Missing DATABASE_URL for PrismaService. Set DATABASE_URL or use createPrismaClient() with a valid accelerateUrl.',
      );
    }

    try {
      const adapter = new PrismaPg({ connectionString });
      return { adapter };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to initialize PrismaPg adapter in buildClientOptions: ${error.message}`);
      }
      throw new Error('Failed to initialize PrismaPg adapter in buildClientOptions.');
    }
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
