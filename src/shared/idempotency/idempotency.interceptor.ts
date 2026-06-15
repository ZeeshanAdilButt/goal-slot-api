import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { IdempotencyService } from './idempotency.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEADER = 'idempotency-key';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();
    const key = req.headers?.[HEADER];
    const userId = req.user?.sub;

    if (!key || !MUTATING_METHODS.has(req.method) || !userId) {
      return next.handle();
    }

    const routePattern = `${req.method} ${req.route?.path ?? req.path}`;
    const requestHash = this.idempotency.hashRequest(req.method, routePattern, req.body);

    const existing = await this.idempotency.find(key, userId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({
          code: 'idempotency_key_reuse_with_different_payload',
          message: 'This idempotency key was already used with a different request payload.',
        });
      }
      const res = context.switchToHttp().getResponse();
      res.status(existing.statusCode);
      return of(existing.responseBody);
    }

    return next.handle().pipe(
      tap((responseBody) => {
        const statusCode = context.switchToHttp().getResponse().statusCode;
        void this.idempotency.store({
          key,
          userId,
          method: req.method,
          routePattern,
          requestHash,
          statusCode,
          responseBody,
        });
      }),
    );
  }
}
