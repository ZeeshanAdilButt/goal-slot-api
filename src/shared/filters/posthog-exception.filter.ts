import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { Request, Response } from 'express'

import { PostHogService } from '../services/posthog.service'

@Catch()
export class PostHogExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PostHogExceptionFilter.name)

  constructor(private readonly posthogService: PostHogService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // Log full error for debugging (Prisma, etc.)
    if (exception instanceof Error) {
      this.logger.error(`[Exception] ${exception.message}`)
      if (exception.stack) this.logger.error(`[Stack] ${exception.stack}`)
      if ('meta' in exception && (exception as any).meta != null) {
        this.logger.error(`[Prisma meta] ${JSON.stringify((exception as any).meta, null, 2)}`)
      }
      if ((exception as any).cause) {
        this.logger.error(`[Cause] ${String((exception as any).cause)}`)
      }
    } else {
      this.logger.error(`[Exception] ${String(exception)}`)
    }

    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    // For HttpExceptions (especially ValidationPipe errors), extract the full response
    // which contains the actual validation error details, not just the generic message
    let message: string | string[]
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse()
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null && 'message' in exceptionResponse) {
        message = (exceptionResponse as any).message
      } else {
        message = exception.message
      }
    } else if (exception instanceof Error) {
      message = exception.message
    } else {
      message = 'Internal server error'
    }

    const error = exception instanceof Error ? exception : new Error(String(exception))

    // Extract user ID from JWT payload (JwtStrategy returns user as req.user with 'sub' property)
    const userId = (request as any).user?.sub || undefined

    // Capture exception in PostHog with full validation details and full error context
    const isError = exception instanceof Error
    this.posthogService.captureException(error, userId, {
      path: request.url,
      method: request.method,
      statusCode: status,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      // Add additional context from JWT payload if available
      userEmail: (request as any).user?.email,
      userRole: (request as any).user?.role,
      // Include validation error details for debugging
      validationErrors: Array.isArray(message) ? message : undefined,
      errorMessage: typeof message === 'string' ? message : JSON.stringify(message),
      // Full error context for PostHog (stack, Prisma meta, cause)
      errorStack: isError ? (exception as Error).stack : undefined,
      prismaMeta: isError && 'meta' in exception && (exception as any).meta != null ? (exception as any).meta : undefined,
      errorCause: isError && (exception as any).cause != null ? String((exception as any).cause) : undefined,
      // Include request data for full debugging context
      queryParams: request.query,
      bodyParams: request.method !== 'GET' ? request.body : undefined,
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
