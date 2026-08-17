import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Binds JwtRefreshStrategy. Use on POST /auth/refresh only -- every other
 * authenticated route must keep JwtAuthGuard, which rejects refresh
 * tokens.
 */
@Injectable()
export class JwtRefreshAuthGuard extends AuthGuard('jwt-refresh') {}
