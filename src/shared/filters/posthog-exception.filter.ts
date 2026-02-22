import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { Request, Response } from 'express'
import { inspect } from 'node:util'

import { PostHogService } from '../services/posthog.service'

@Catch()
export class PostHogExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PostHogExceptionFilter.name)

  constructor(private readonly posthogService: PostHogService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const rawException = inspect(exception, {
      depth: null,
      showHidden: true,
      maxArrayLength: null,
      maxStringLength: null,
      colors: false,
    })
    const serializedException = this.toSerializable(exception)
    this.logger.error(`[Exception:raw] ${rawException}`)
    this.logger.error(`[Exception:json] ${JSON.stringify(serializedException)}`)

    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    // Keep API response shape stable while logging full raw exception separately.
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

    const error =
      exception instanceof Error ? exception : new Error(rawException)

    // Extract user ID from JWT payload (JwtStrategy returns user as req.user with 'sub' property)
    const userId = (request as any).user?.sub || undefined

    // Capture full raw exception payload and request context in PostHog.
    try {
      this.posthogService.captureException(error, userId, {
        path: request.url,
        method: request.method,
        statusCode: status,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
        userEmail: (request as any).user?.email,
        userRole: (request as any).user?.role,
        queryParams: request.query,
        bodyParams: request.method !== 'GET' ? request.body : undefined,
        exceptionRaw: rawException,
        exceptionJson: serializedException,
      })
    } catch (captureError) {
      if (captureError instanceof Error) {
        this.logger.error(`[PostHogCaptureFailure] ${captureError.message}`)
        if (captureError.stack) {
          this.logger.error(captureError.stack)
        }
      } else {
        this.logger.error(`[PostHogCaptureFailure] ${String(captureError)}`)
      }
    }

    // Continue with default error handling
    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    })
  }

  private toSerializable(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === 'bigint') {
      return value.toString()
    }

    if (value == null) {
      return value
    }

    if (typeof value === 'function') {
      return `[Function ${value.name || 'anonymous'}]`
    }

    if (typeof value !== 'object') {
      return value
    }

    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)

    if (Array.isArray(value)) {
      return value.map((entry) => this.toSerializable(entry, seen))
    }

    const output: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        output[key] = this.toSerializable((value as Record<string, unknown>)[key], seen)
      } catch (error) {
        output[key] = `[Unserializable property: ${String(error)}]`
      }
    }
    return output
  }
}
