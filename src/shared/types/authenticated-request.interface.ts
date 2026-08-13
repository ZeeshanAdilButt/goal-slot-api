import { Request } from 'express';
import { UserRole } from '@prisma/client';

/**
 * Shape of `req.user` once `JwtStrategy#validate` has run (see
 * src/modules/auth/strategies/jwt.strategy.ts). Every authenticated
 * controller reads `req.user.sub` / `req.user.role` off the request that
 * Passport attaches this to, so a single shared request type is used
 * instead of `any` at each call site.
 */
export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: UserRole;
  isDisabled: boolean;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
