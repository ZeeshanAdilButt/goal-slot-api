import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common'
import { Request, Response } from 'express'

import { PostHogService } from '../services/posthog.service'

@Catch()
export class PostHogExceptionFilter implements ExceptionFilter {
  constructor(private readonly posthogService: PostHogService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    const message =
      exception instanceof HttpException
        ? exception.message
        : exception instanceof Error
          ? exception.message
          : 'Internal server error'

    const error = exception instanceof Error ? exception : new Error(String(exception))

    // Extract user ID from JWT payload (JwtStrategy returns user as req.user with 'sub' property)
    const userId = (request as any).user?.sub || undefined

    // Capture exception in PostHog
    this.posthogService.captureException(error, userId, {
      path: request.url,
      method: request.method,
      statusCode: status,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      // Add additional context from JWT payload if available
      userEmail: (request as any).user?.email,
      userRole: (request as any).user?.role,
    })

    // Continue with default error handling
    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    })
  }
}
