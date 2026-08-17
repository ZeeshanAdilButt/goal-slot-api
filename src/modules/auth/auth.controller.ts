import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ThrottlerGuard, Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import {
  RegisterDto,
  LoginDto,
  SSOLoginDto,
  SendOTPDto,
  VerifyOTPDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SendChangePasswordOTPDto,
  ChangePasswordDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshAuthGuard } from './guards/jwt-refresh-auth.guard';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';

// check-email is unauthenticated by design (it runs before the user has any
// token) and its {exists} response is a direct account-existence oracle, so
// it's throttled per-IP to make mass enumeration impractical. The signup
// page still needs it for its "email already registered, please log in"
// inline check, so it can't simply be removed.
export const CHECK_EMAIL_THROTTLE_TTL_MS = 60_000; // 1 minute
export const CHECK_EMAIL_THROTTLE_LIMIT = 10;

// Per-IP backstop on /auth/login, on top of the per-account lockout in
// AuthService#login. Deliberately generous: shared IPs (offices, campus
// NAT, mobile carrier CGNAT) legitimately produce many real login attempts
// per minute, and this bucket only needs to blunt a scripted credential
// spray, not police normal traffic.
export const LOGIN_THROTTLE_TTL_MS = 60_000; // 1 minute
export const LOGIN_THROTTLE_LIMIT = 20;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('check-email')
  @UseGuards(ThrottlerGuard)
  @Throttle({
    'check-email': {
      limit: CHECK_EMAIL_THROTTLE_LIMIT,
      ttl: CHECK_EMAIL_THROTTLE_TTL_MS,
    },
  })
  // AuthModule registers 'check-email' and 'login' in the same
  // ThrottlerModule.forRoot() array, so ThrottlerGuard evaluates both
  // buckets on every guarded route in this controller unless skipped.
  // Without this, check-email traffic would also be capped by the
  // 'login' bucket's default limit for no reason -- this route has
  // nothing to do with login attempts.
  @SkipThrottle({ login: true })
  @ApiOperation({ summary: 'Check if email is already registered' })
  @ApiQuery({ name: 'email', type: String })
  @ApiResponse({ status: 200, description: 'Email existence check result' })
  async checkEmailExists(@Query('email') email: string) {
    const exists = await this.authService.checkEmailExists(email);
    return { exists };
  }

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP verification code' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({
    status: 400,
    description: 'Bad request - rate limit or cooldown',
  })
  @ApiResponse({
    status: 409,
    description: 'Email already registered (signup only)',
  })
  async sendOTP(@Body() dto: SendOTPDto) {
    return this.authService.sendOTP(dto);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP code' })
  @ApiResponse({ status: 200, description: 'OTP verified successfully' })
  @ApiResponse({ status: 400, description: 'OTP not found or expired' })
  @ApiResponse({ status: 401, description: 'Invalid OTP code' })
  async verifyOTP(@Body() dto: VerifyOTPDto) {
    const valid = await this.authService.verifyOTP(dto);
    return { success: valid, message: 'OTP verified successfully.' };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send forgot password OTP' })
  @ApiResponse({ status: 200, description: 'Password reset code sent' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.sendForgotPasswordOTP(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with OTP' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Invalid OTP or user not found' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - invalid OTP' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: { limit: LOGIN_THROTTLE_LIMIT, ttl: LOGIN_THROTTLE_TTL_MS } })
  // See the matching comment on check-email above: without this, login
  // traffic would silently also be capped by 'check-email's tighter
  // default limit, undermining the more generous limit set above.
  @SkipThrottle({ 'check-email': true })
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('sso')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login via SSO' })
  @ApiResponse({ status: 200, description: 'SSO login successful' })
  @ApiResponse({ status: 401, description: 'Invalid SSO token' })
  async ssoLogin(@Body() dto: SSOLoginDto) {
    return this.authService.ssoLogin(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Current user data' })
  async getProfile(@Request() req: AuthenticatedRequest) {
    return this.authService.validateUser(req.user.sub);
  }

  // Deliberately NOT JwtAuthGuard: this is the one endpoint that must
  // accept a refresh token, and it must reject an access token so a
  // stolen access token cannot be laundered into a fresh 30-day pair.
  @Post('refresh')
  @UseGuards(JwtRefreshAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token (send the refresh token as the bearer)',
  })
  async refreshToken(@Request() req: AuthenticatedRequest) {
    return this.authService.refreshToken(req.user.sub);
  }

  @Post('send-change-password-otp')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP for password change' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({
    status: 400,
    description: 'Bad request - SSO user or rate limit',
  })
  @ApiResponse({ status: 401, description: 'Invalid current password' })
  async sendChangePasswordOTP(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SendChangePasswordOTPDto,
  ) {
    return this.authService.sendChangePasswordOTP(
      req.user.sub,
      dto.currentPassword,
    );
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password with OTP verification' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({
    status: 400,
    description: 'Bad request - SSO user or invalid OTP',
  })
  @ApiResponse({ status: 401, description: 'Invalid current password' })
  async changePassword(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      req.user.sub,
      dto.currentPassword,
      dto.otp,
      dto.newPassword,
    );
  }
}
