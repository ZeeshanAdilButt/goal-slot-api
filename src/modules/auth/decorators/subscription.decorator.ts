import { SetMetadata } from '@nestjs/common';
import { SUBSCRIPTION_REQUIRED_KEY, SKIP_SUBSCRIPTION_CHECK_KEY } from '../guards/subscription.guard';

/**
 * Decorator to require active subscription for an endpoint.
 * Use on endpoints that modify data or require Pro features.
 */
export const SubscriptionRequired = () => SetMetadata(SUBSCRIPTION_REQUIRED_KEY, true);

/**
 * Decorator to skip subscription check for an endpoint.
 * Use on read-only endpoints or payment-related endpoints.
 */
export const SkipSubscriptionCheck = () => SetMetadata(SKIP_SUBSCRIPTION_CHECK_KEY, true);
