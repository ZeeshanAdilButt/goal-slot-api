import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super(PrismaService.buildClientOptions());
  }

  private static buildClientOptions() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return {};
    const adapter = new PrismaPg({ connectionString });
    return { adapter };
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
