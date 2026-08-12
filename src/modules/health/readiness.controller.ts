import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { HealthService } from './health.service';

/**
 * Readiness, at /api/ready.
 *
 * Separate from HealthController because that one is mounted at /api/health
 * and readiness deliberately sits beside it rather than under it. The
 * distinction is not cosmetic:
 *
 * - /api/health is liveness. It touches nothing, so a supervisor restarts the
 *   process only when the process itself is wedged. A database that is
 *   briefly slow should not trigger a crash loop.
 * - /api/ready says this instance can serve a real request right now. The
 *   deploy script gates on this, because /api/health stays green when a newly
 *   started process cannot reach the database, and a deploy that leaves the
 *   API unable to answer anything is not a successful deploy.
 * - /api/health/detailed is for humans and dashboards. It checks four
 *   dependencies and caches for ten seconds, which is right for a status page
 *   and wrong for a probe: a cached pass could predate the restart being
 *   verified.
 */
@ApiTags('health')
@Controller('ready')
export class ReadinessController {
  private readonly logger = new Logger(ReadinessController.name);

  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Readiness check, verifies the database is reachable right now',
  })
  @ApiResponse({ status: 200, description: 'The service can serve traffic' })
  @ApiResponse({ status: 503, description: 'A dependency is unavailable' })
  async ready(@Res({ passthrough: true }) res: Response) {
    // Uncached and time-bounded. checkDatabase races SELECT 1 against a
    // 2-second timeout, so a hung database fails the probe instead of
    // hanging it.
    const database = await this.healthService.checkDatabase();

    if (!database.ok) {
      this.logger.error(
        `readiness check failed: database unreachable after ${database.latencyMs}ms`,
      );
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'not ready',
        database: 'unreachable',
        latencyMs: database.latencyMs,
        timestamp: new Date().toISOString(),
      };
    }

    res.status(HttpStatus.OK);
    return {
      status: 'ready',
      database: 'ok',
      latencyMs: database.latencyMs,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
