import { Body, Controller, Get, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import type { Response } from 'express';
import { EmailService } from '../email/email.service';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly emailService: EmailService,
    private readonly healthService: HealthService,
  ) {}

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
                latencyMs: { type: 'number' },
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
      result.status === 'down'
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.OK,
    );

    return result;
  }

  @Post('test-email/share-invitation')
  @ApiOperation({ summary: 'Test share invitation email' })
  @ApiResponse({ status: 200, description: 'Email sent successfully' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        toEmail: { type: 'string', example: 'test@example.com' },
        inviterName: { type: 'string', example: 'John Doe' },
        inviterEmail: { type: 'string', example: 'john@example.com' },
        inviteToken: { type: 'string', example: 'test-token-123' },
        isExistingUser: { type: 'boolean', example: false },
      },
      required: ['toEmail', 'inviterName', 'inviterEmail', 'inviteToken'],
    },
  })
  async testShareInvitationEmail(
    @Body()
    body: {
      toEmail: string;
      inviterName: string;
      inviterEmail: string;
      inviteToken: string;
      isExistingUser?: boolean;
    },
  ) {
    const result = await this.emailService.sendShareInvitation({
      toEmail: body.toEmail,
      inviterName: body.inviterName,
      inviterEmail: body.inviterEmail,
      inviteToken: body.inviteToken,
      isExistingUser: body.isExistingUser ?? false,
    });

    return {
      success: true,
      message: 'Share invitation email sent successfully',
      result,
    };
  }

  @Post('test-email/welcome')
  @ApiOperation({ summary: 'Test welcome email' })
  @ApiResponse({ status: 200, description: 'Email sent successfully' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        toEmail: { type: 'string', example: 'test@example.com' },
        userName: { type: 'string', example: 'Jane Doe' },
      },
      required: ['toEmail', 'userName'],
    },
  })
  async testWelcomeEmail(
    @Body()
    body: {
      toEmail: string;
      userName: string;
    },
  ) {
    const result = await this.emailService.sendWelcomeEmail({
      toEmail: body.toEmail,
      userName: body.userName,
    });

    return {
      success: true,
      message: 'Welcome email sent successfully',
      result,
    };
  }

  @Post('test-email/share-accepted')
  @ApiOperation({ summary: 'Test share accepted notification email' })
  @ApiResponse({ status: 200, description: 'Email sent successfully' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        toEmail: { type: 'string', example: 'test@example.com' },
        accepterName: { type: 'string', example: 'Alice Smith' },
        accepterEmail: { type: 'string', example: 'alice@example.com' },
      },
      required: ['toEmail', 'accepterName', 'accepterEmail'],
    },
  })
  async testShareAcceptedEmail(
    @Body()
    body: {
      toEmail: string;
      accepterName: string;
      accepterEmail: string;
    },
  ) {
    await this.emailService.sendShareAcceptedNotification({
      toEmail: body.toEmail,
      accepterName: body.accepterName,
      accepterEmail: body.accepterEmail,
    });

    return {
      success: true,
      message: 'Share accepted notification email sent successfully',
    };
  }
}

