import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Override the default IP-based tracker so rate limits are scoped per user
 * (`req.user.sub`). Falls back to the IP if no user is attached (which
 * should not happen since the JwtAuthGuard runs first).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId: string | undefined = req?.user?.sub;
    if (userId) return `user:${userId}`;
    // Fallback — ip can be string | string[] depending on proxy hops
    const ip = Array.isArray(req?.ips) && req.ips.length > 0 ? req.ips[0] : req?.ip;
    return `ip:${ip ?? 'unknown'}`;
  }
}
