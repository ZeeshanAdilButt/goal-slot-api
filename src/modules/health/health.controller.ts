import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';

// This is the one controller with no JwtAuthGuard, and there is no global
// guard, so everything mounted here is reachable by anyone on the internet.
// Keep it to read-only probes. Anything that sends mail, writes to the
// database, or performs an action belongs on an authenticated controller.
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Get('detailed')
  @ApiOperation({ summary: 'Detailed health check endpoint' })
  @ApiResponse({
    status: 200,
    description: 'Detailed health status with dependency checks',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ok', 'degraded', 'down'],
          description: 'Overall health status',
        },
        timestamp: {
          type: 'string',
          description: 'ISO timestamp of the check',
        },
        checks: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                latencyMs: { type: 'number' },
              },
            },
            supabase: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                configured: { type: 'boolean' },
              },
            },
            resend: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                configured: { type: 'boolean' },
              },
            },
            geminiShared: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                configured: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  })
  async getDetailedHealth(@Res({ passthrough: true }) res: Response) {
    const result = await this.healthService.getDetailedHealth();

    res.status(
      result.status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK,
    );

    return result;
  }
}
