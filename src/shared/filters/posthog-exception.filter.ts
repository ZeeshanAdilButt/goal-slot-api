import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { inspect } from 'node:util';

import { PostHogService } from '../services/posthog.service';
import { AuthenticatedUser } from '../types/authenticated-request.interface';

// This filter runs for every exception, including ones thrown before
// JwtAuthGuard ever attaches `user` to the request, so — unlike
// AuthenticatedRequest — `user` here is genuinely optional.
type RequestWithOptionalUser = Request & { user?: AuthenticatedUser };

/**
 * Query parameters whose names mark a value as a credential rather than
 * context. Matched case-insensitively as a substring, so `token` also covers
 * `inviteToken` and `access_token`.
 *
 * This exists because /api/sharing/accept takes a live invite token as
 * ?token=, so an exception on that route used to ship a working credential
 * to a third party analytics vendor.
 */
const SENSITIVE_QUERY_PARAM_PATTERNS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'key',
  'auth',
  'code',
  'signature',
  'session',
  'credential',
];

const REDACTED = '[REDACTED]';

// Anything longer than this in a query value is truncated before it leaves
// the process, so an unrecognised parameter name cannot smuggle a large blob.
const MAX_QUERY_VALUE_LENGTH = 200;

// Bounds for the JSON walker below. They mirror the inspect() options so the
// two payloads that go to PostHog are limited the same way.
const MAX_SERIALIZED_DEPTH = 4;
const MAX_SERIALIZED_STRING_LENGTH = 2000;
const MAX_SERIALIZED_ARRAY_LENGTH = 100;

@Catch()
export class PostHogExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PostHogExceptionFilter.name);

  constructor(private readonly posthogService: PostHogService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // Bounded on purpose. `depth: null` plus `showHidden: true` walks
    // non-enumerable properties to unlimited depth, which on a Prisma or
    // axios error reaches connection strings, request bodies and auth
    // headers, and then the whole thing is shipped to PostHog. These limits
    // keep enough of the error to debug it without turning every exception
    // into a data export.
    const rawException = inspect(exception, {
      depth: 4,
      showHidden: false,
      maxArrayLength: 100,
      maxStringLength: 2000,
      colors: false,
    });
    const serializedException = this.toSerializable(exception);
    this.logger.error(`[Exception:raw] ${rawException}`);
    this.logger.error(
      `[Exception:json] ${JSON.stringify(serializedException)}`,
    );

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithOptionalUser>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Keep API response shape stable while logging full raw exception separately.
    let message: string | string[];
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null &&
        'message' in exceptionResponse
      ) {
        message = (exceptionResponse as { message: string | string[] }).message;
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    } else {
      message = 'Internal server error';
    }

    const error =
      exception instanceof Error ? exception : new Error(rawException);

    // Extract user ID from JWT payload (JwtStrategy returns user as req.user with 'sub' property)
    const userId = request.user?.sub || undefined;

    // Capture full raw exception payload and request context in PostHog.
    try {
      this.posthogService.captureException(error, userId, {
        path: request.url,
        method: request.method,
        statusCode: status,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
        userEmail: request.user?.email,
        userRole: request.user?.role,
        queryParams: this.redactQueryParams(request.query),
        exceptionRaw: rawException,
        exceptionJson: serializedException,
      });
    } catch (captureError) {
      if (captureError instanceof Error) {
        this.logger.error(`[PostHogCaptureFailure] ${captureError.message}`);
        if (captureError.stack) {
          this.logger.error(captureError.stack);
        }
      } else {
        this.logger.error(`[PostHogCaptureFailure] ${String(captureError)}`);
      }
    }

    // Continue with default error handling
    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    });
  }

  /**
   * Replaces credential-looking query values with a marker and truncates the
   * rest, so what reaches PostHog is the shape of the request rather than its
   * contents.
   *
   * Deny-list rather than allow-list because the parameter names in use are
   * spread across every controller, but the truncation and the recursion
   * limit below mean an unmatched name still cannot ship much.
   */
  private redactQueryParams(query: unknown, depth = 0): unknown {
    if (query == null || typeof query !== 'object') {
      return this.clampQueryValue(query);
    }

    if (depth >= 3) {
      return '[Truncated]';
    }

    if (Array.isArray(query)) {
      return query
        .slice(0, 20)
        .map((entry) => this.redactQueryParams(entry, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      query as Record<string, unknown>,
    )) {
      output[key] = this.isSensitiveQueryParam(key)
        ? REDACTED
        : this.redactQueryParams(value, depth + 1);
    }
    return output;
  }

  private isSensitiveQueryParam(name: string): boolean {
    const lowered = name.toLowerCase();
    return SENSITIVE_QUERY_PARAM_PATTERNS.some((pattern) =>
      lowered.includes(pattern),
    );
  }

  private clampQueryValue(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }
    return value.length > MAX_QUERY_VALUE_LENGTH
      ? `${value.slice(0, MAX_QUERY_VALUE_LENGTH)}...[truncated]`
      : value;
  }

  /**
   * Depth and length limits mirror the inspect() options above. Without them
   * this walker undoes the bounding, because Object.getOwnPropertyNames pulls
   * in non-enumerable properties and it recursed forever.
   */
  private toSerializable(
    value: unknown,
    seen = new WeakSet<object>(),
    depth = 0,
  ): unknown {
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value == null) {
      return value;
    }

    if (typeof value === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }

    if (typeof value === 'string') {
      return value.length > MAX_SERIALIZED_STRING_LENGTH
        ? `${value.slice(0, MAX_SERIALIZED_STRING_LENGTH)}...[truncated]`
        : value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }

    if (depth >= MAX_SERIALIZED_DEPTH) {
      return '[Truncated: max depth]';
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_SERIALIZED_ARRAY_LENGTH)
        .map((entry) => this.toSerializable(entry, seen, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (this.isSensitiveQueryParam(key)) {
        output[key] = REDACTED;
        continue;
      }
      try {
        output[key] = this.toSerializable(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch (error) {
        output[key] = `[Unserializable property: ${String(error)}]`;
      }
    }
    return output;
  }
}
