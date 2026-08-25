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

  /**
   * Which credential authenticated this request: 'access' for a web/mobile
   * session, 'cli' for a token minted by `goalslot login`. Absent on tokens
   * issued before the claim existed, which are treated as 'access'.
   *
   * Route handlers that must not be reachable from a CLI token check this.
   */
  typ?: 'access' | 'cli';

  /** CliToken row id, present only when typ === 'cli'. */
  cid?: string;

  /** Granted CLI scopes, present only when typ === 'cli'. 'full' in v1. */
  scopes?: string[];
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
