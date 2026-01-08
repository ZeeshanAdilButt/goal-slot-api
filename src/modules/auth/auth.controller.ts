import { Controller, Post, Body, Get, UseGuards, Request, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, SSOLoginDto, SendOTPDto, VerifyOTPDto, ForgotPasswordDto, ResetPasswordDto, SendChangePasswordOTPDto, ChangePasswordDto } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('check-email')
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
  @ApiResponse({ status: 400, description: 'Bad request - rate limit or cooldown' })
  @ApiResponse({ status: 409, description: 'Email already registered (signup only)' })
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
  async getProfile(@Request() req: any) {
    return this.authService.validateUser(req.user.sub);
  }

  @Post('refresh')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  async refreshToken(@Request() req: any) {
    return this.authService.refreshToken(req.user.sub);
  }

  @Post('send-change-password-otp')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP for password change' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - SSO user or rate limit' })
  @ApiResponse({ status: 401, description: 'Invalid current password' })
  async sendChangePasswordOTP(@Request() req: any, @Body() dto: SendChangePasswordOTPDto) {
    return this.authService.sendChangePasswordOTP(req.user.sub, dto.currentPassword);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password with OTP verification' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - SSO user or invalid OTP' })
  @ApiResponse({ status: 401, description: 'Invalid current password' })
  async changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.sub, dto.currentPassword, dto.otp, dto.newPassword);
  }
}
