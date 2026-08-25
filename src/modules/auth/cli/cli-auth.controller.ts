import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request as ExpressRequest, Response } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.interface';
import {
  CliAuthService,
  DEVICE_POLL_INTERVAL_SECONDS,
} from './cli-auth.service';
import {
  ApproveCliSessionDto,
  CreateCliSessionDto,
  DeviceLookupQueryDto,
  ExchangeCliTokenDto,
  RefreshCliTokenDto,
  RenameCliTokenDto,
} from './dto/cli-auth.dto';

// Session creation is unauthenticated by necessity - it runs before the user
// has touched a browser - so it is capped per IP. Ten pending logins per ten
// minutes is far more than any human needs and far less than is useful for
// filling the table or farming device codes.
export const CLI_SESSION_THROTTLE_TTL_MS = 600_000; // 10 minutes
export const CLI_SESSION_THROTTLE_LIMIT = 10;

// The token endpoint is also unauthenticated (the CLI holds no bearer yet) and
// is polled in device mode, so its budget is per minute and sized for polling:
// a well-behaved CLI polls every 5s, i.e. 12 times a minute. The real interval
// enforcement is server-side in CliAuthService#recordPoll, keyed per session;
// this bucket is the per-IP backstop for callers who ignore it.
export const CLI_TOKEN_THROTTLE_TTL_MS = 60_000; // 1 minute
export const CLI_TOKEN_THROTTLE_LIMIT = 60;

/**
 * CLI authentication.
 *
 * WIRE FORMAT: camelCase throughout, matching the rest of this API rather than
 * RFC 8628's snake_case. There is no third-party OAuth client here, only the
 * first-party GoalSlot CLI. See the header comment on dto/cli-auth.dto.ts.
 *
 * Nothing in this controller ever issues an HTTP 3xx. The loopback redirect is
 * returned as a JSON string that the approval page navigates to client-side, so
 * there is no redirect for a crafted link to hijack.
 */
@ApiTags('auth')
@Controller('auth/cli')
export class CliAuthController {
  constructor(private readonly cliAuthService: CliAuthService) {}

  // -------------------------------------------------------------------------
  // Public: session creation and token exchange
  // -------------------------------------------------------------------------

  @Post('session')
  @UseGuards(ThrottlerGuard)
  @Throttle({
    'cli-session': {
      limit: CLI_SESSION_THROTTLE_LIMIT,
      ttl: CLI_SESSION_THROTTLE_TTL_MS,
    },
  })
  // Both buckets are registered in this module's ThrottlerModule.forRoot()
  // array, so without this skip the generous polling bucket would also apply
  // here (and vice versa below). Same pattern as auth.controller.ts.
  @SkipThrottle({ 'cli-token': true })
  @ApiOperation({ summary: 'Create a pending CLI authorization session' })
  @ApiResponse({ status: 201, description: 'Session created' })
  @ApiResponse({
    status: 400,
    description: 'Validation or invalid redirectUri',
  })
  @ApiResponse({ status: 429, description: 'Too many sessions from this IP' })
  async createSession(
    @Body() dto: CreateCliSessionDto,
    @Req() req: ExpressRequest,
  ) {
    return this.cliAuthService.createSession(
      dto,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    'cli-token': {
      limit: CLI_TOKEN_THROTTLE_LIMIT,
      ttl: CLI_TOKEN_THROTTLE_TTL_MS,
    },
  })
  @SkipThrottle({ 'cli-session': true })
  @ApiOperation({
    summary: 'Exchange an approved session for CLI tokens, or poll it',
  })
  @ApiResponse({ status: 200, description: 'Tokens issued' })
  @ApiResponse({ status: 202, description: 'Still pending approval' })
  @ApiResponse({ status: 401, description: 'Invalid session, code or PKCE' })
  @ApiResponse({ status: 403, description: 'The request was denied' })
  @ApiResponse({ status: 410, description: 'Expired or already used' })
  @ApiResponse({ status: 429, description: 'Polling too fast' })
  async exchangeToken(
    @Body() dto: ExchangeCliTokenDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.cliAuthService.exchangeToken(dto, req.ip);

    if ('slowDown' in result) {
      res.setHeader('Retry-After', String(DEVICE_POLL_INTERVAL_SECONDS));
      res.status(HttpStatus.TOO_MANY_REQUESTS);
      return { status: result.status, interval: result.interval };
    }

    if ('pending' in result) {
      // 202 Accepted: the request was understood and is waiting on a human.
      // Deliberately not RFC 8628's 400 authorization_pending - see the note in
      // CliAuthService#exchangeToken.
      res.status(HttpStatus.ACCEPTED);
      return { status: result.status, interval: result.interval };
    }

    return result;
  }

  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    'cli-token': {
      limit: CLI_TOKEN_THROTTLE_LIMIT,
      ttl: CLI_TOKEN_THROTTLE_TTL_MS,
    },
  })
  @SkipThrottle({ 'cli-session': true })
  @ApiOperation({ summary: 'Rotate a CLI refresh token' })
  @ApiResponse({ status: 200, description: 'New token pair issued' })
  @ApiResponse({
    status: 401,
    description: 'Missing, revoked, expired or replayed token',
  })
  async refreshToken(
    @Body() dto: RefreshCliTokenDto,
    @Req() req: ExpressRequest,
  ) {
    return this.cliAuthService.refresh(dto.refreshToken, req.ip);
  }

  // -------------------------------------------------------------------------
  // Authenticated: the web approval page
  // -------------------------------------------------------------------------

  @Get('device/lookup')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resolve a device user code to its session' })
  @ApiQuery({ name: 'userCode', type: String, example: 'BXKQ-7TDM' })
  @ApiResponse({ status: 200, description: 'Session metadata' })
  @ApiResponse({ status: 404, description: 'Unknown, expired or used code' })
  async deviceLookup(
    @Query() query: DeviceLookupQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.cliAuthService.lookupByUserCode(query.userCode, req.user.sub);
  }

  @Get('sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Read the metadata shown on the approval page' })
  @ApiResponse({ status: 200, description: 'Session metadata' })
  @ApiResponse({ status: 404, description: 'Unknown session' })
  @ApiResponse({ status: 409, description: 'Already approved or denied' })
  @ApiResponse({ status: 410, description: 'Expired' })
  async getSession(@Param('sessionId', new ParseUUIDPipe()) sessionId: string) {
    return this.cliAuthService.getSessionMetadata(sessionId);
  }

  @Post('sessions/:sessionId/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve a pending CLI authorization' })
  @ApiResponse({ status: 200, description: 'Approved' })
  @ApiResponse({ status: 404, description: 'Unknown session' })
  @ApiResponse({ status: 409, description: 'Already approved or denied' })
  @ApiResponse({ status: 410, description: 'Expired' })
  async approveSession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() dto: ApproveCliSessionDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.cliAuthService.approveSession(sessionId, req.user.sub, dto);
  }

  @Post('sessions/:sessionId/deny')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deny a pending CLI authorization' })
  @ApiResponse({ status: 200, description: 'Denied' })
  @ApiResponse({ status: 404, description: 'Unknown session' })
  @ApiResponse({ status: 409, description: 'Already approved or denied' })
  @ApiResponse({ status: 410, description: 'Expired' })
  async denySession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.cliAuthService.denySession(sessionId, req.user.sub);
  }

  // -------------------------------------------------------------------------
  // Authenticated: token management (Settings -> CLI tokens)
  // -------------------------------------------------------------------------

  @Get('tokens')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List this account CLI tokens' })
  @ApiResponse({ status: 200, description: 'Tokens, never token material' })
  async listTokens(@Request() req: AuthenticatedRequest) {
    return this.cliAuthService.listTokens(req.user.sub);
  }

  @Patch('tokens/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rename a CLI token' })
  @ApiResponse({ status: 200, description: 'Renamed' })
  @ApiResponse({ status: 404, description: 'Not found or not owned' })
  async renameToken(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RenameCliTokenDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.cliAuthService.renameToken(req.user.sub, id, dto.name);
  }

  @Post('tokens/revoke-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke every CLI token on this account' })
  @ApiResponse({ status: 200, description: 'Count of tokens revoked' })
  async revokeAllTokens(@Request() req: AuthenticatedRequest) {
    return this.cliAuthService.revokeAllTokens(req.user.sub);
  }

  @Delete('tokens/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one CLI token' })
  @ApiResponse({ status: 204, description: 'Revoked' })
  @ApiResponse({ status: 404, description: 'Not found or not owned' })
  async revokeToken(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.cliAuthService.revokeToken(req.user.sub, id);
  }
}
