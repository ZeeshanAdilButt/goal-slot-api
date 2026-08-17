import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
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
      // node-postgres' own defaults (max: 10, connectionTimeoutMillis: 0)
      // are wrong for a single long-lived server process handling
      // concurrent requests: 10 connections caps throughput well below
      // what the app needs under real load, and an unset connection
      // timeout means a request that can't get a pooled connection hangs
      // forever instead of failing fast. Both are overridable via env so
      // a deploy can tune them without a code change.
      const adapter = new PrismaPg({
        connectionString,
        max: Number(process.env.DATABASE_POOL_MAX) || 20,
        idleTimeoutMillis:
          Number(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS) || 30_000,
        connectionTimeoutMillis:
          Number(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS) || 10_000,
      });
      return { adapter };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to initialize PrismaPg adapter in buildClientOptions: ${error.message}`,
        );
      }
      throw new Error(
        'Failed to initialize PrismaPg adapter in buildClientOptions.',
      );
    }
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
