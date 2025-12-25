import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service';

export const SUBSCRIPTION_REQUIRED_KEY = 'subscription_required';
export const SKIP_SUBSCRIPTION_CHECK_KEY = 'skip_subscription_check';

/**
 * Guard that checks if user's subscription is in good standing.
 * Blocks access when:
 * - invoicePending is true (payment awaiting)
 * - subscriptionStatus is 'past_due' or 'paused'
 * 
 * Use @SkipSubscriptionCheck() decorator to bypass this guard on specific endpoints.
 * Use @SubscriptionRequired() decorator to enforce subscription check.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if this endpoint should skip subscription check
    const skipCheck = this.reflector.getAllAndOverride<boolean>(SKIP_SUBSCRIPTION_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipCheck) {
      return true;
    }

    // Check if subscription is required (opt-in mode)
    const subscriptionRequired = this.reflector.getAllAndOverride<boolean>(SUBSCRIPTION_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If not explicitly required, allow access
    if (!subscriptionRequired) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userId = request.user?.sub;

    if (!userId) {
      return true; // Let JwtAuthGuard handle unauthenticated requests
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionStatus: true,
        invoicePending: true,
        unlimitedAccess: true,
        userType: true,
        plan: true,
      },
    });

    if (!user) {
      return true; // User not found, let other guards handle
    }

    // Internal users and unlimited access users are never blocked
    if (user.userType === 'INTERNAL' || user.unlimitedAccess) {
      return true;
    }

    // Free plan users don't have subscription requirements
    if (user.plan === 'FREE') {
      return true;
    }

    // Block if invoice is pending payment
    if (user.invoicePending) {
      throw new ForbiddenException({
        code: 'INVOICE_PENDING',
        message: 'Your invoice is pending payment. Please update your payment method to continue.',
      });
    }

    // Block if subscription is past due or paused
    const blockedStatuses = ['past_due', 'paused', 'unpaid'];
    if (user.subscriptionStatus && blockedStatuses.includes(user.subscriptionStatus)) {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_ISSUE',
        message: `Your subscription is ${user.subscriptionStatus}. Please resolve to continue using Pro features.`,
        status: user.subscriptionStatus,
      });
    }

    return true;
  }
}
