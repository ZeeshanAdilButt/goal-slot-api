import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface IdempotencyLookup {
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
}

@Injectable()
export class IdempotencyService {
  private lastSweepAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  hashRequest(method: string, routePattern: string, body: unknown): string {
    const payload = JSON.stringify({ method, routePattern, body: body ?? null });
    return createHash('sha256').update(payload).digest('hex');
  }

  async find(key: string, userId: string): Promise<IdempotencyLookup | null> {
    const record = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!record || record.userId !== userId || record.expiresAt.getTime() < Date.now()) {
      return null;
    }
    return {
      requestHash: record.requestHash,
      statusCode: record.statusCode,
      responseBody: record.responseBody,
    };
  }

  async store(params: {
    key: string;
    userId: string;
    method: string;
    routePattern: string;
    requestHash: string;
    statusCode: number;
    responseBody: unknown;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + TTL_MS);
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          key: params.key,
          userId: params.userId,
          method: params.method,
          routePattern: params.routePattern,
          requestHash: params.requestHash,
          statusCode: params.statusCode,
          responseBody: (params.responseBody ?? null) as object,
          expiresAt,
        },
      });
    } catch {
      // A concurrent request already persisted this key; safe to ignore.
    }
    void this.maybeSweep();
  }

  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    try {
      await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    } catch {
      // Best-effort cleanup.
    }
  }
}
