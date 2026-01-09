import { Controller, Get, Put, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { 
  UpdateUserDto, 
  CreateInternalUserDto,
  AdminToggleUserStatusDto,
  AdminAssignPlanDto,
  AdminBulkAssignPlanDto,
  AdminSetEmailVerifiedDto,
} from './dto/users.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Request() req: any) {
    return this.usersService.findById(req.user.sub);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update current user profile' })
  async updateProfile(@Request() req: any, @Body() dto: UpdateUserDto) {
    return this.usersService.updateProfile(req.user.sub, dto);
  }

  // Admin endpoints
  @Get('admin/list')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'List all users with extended info (Admin only)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  async listUsers(
    @Request() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
  ) {
    return this.usersService.listUsers(req.user.sub, page, limit, search);
  }

  @Get('admin/stats')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get user statistics (Admin only)' })
  async getUserStats(@Request() req: any) {
    return this.usersService.getUserStats(req.user.sub);
  }

  @Get('admin/user/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get single user details (Admin only)' })
  async getUserDetails(@Request() req: any, @Param('userId') userId: string) {
    return this.usersService.getUserDetails(req.user.sub, userId);
  }

  @Post('admin/internal')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Create internal user (Admin only)' })
  async createInternalUser(@Request() req: any, @Body() dto: CreateInternalUserDto) {
    return this.usersService.createInternalUser(req.user.sub, dto);
  }

  @Post('admin/grant-access/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Grant free Pro access to user (Admin only)' })
  async grantFreeAccess(@Request() req: any, @Param('userId') userId: string) {
    return this.usersService.grantFreeAccess(req.user.sub, userId);
  }

  @Post('admin/revoke-access/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Revoke free access from user (Admin only)' })
  async revokeFreeAccess(@Request() req: any, @Param('userId') userId: string) {
    return this.usersService.revokeFreeAccess(req.user.sub, userId);
  }

  @Post('admin/toggle-status/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Enable or disable a user account (Admin only)' })
  async toggleUserStatus(
    @Request() req: any, 
    @Param('userId') userId: string,
    @Body() dto: AdminToggleUserStatusDto,
  ) {
    return this.usersService.toggleUserStatus(req.user.sub, userId, dto);
  }

  @Post('admin/bulk-assign-plan')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Bulk assign a subscription plan to users (Admin only)' })
  async bulkAssignPlan(
    @Request() req: any, 
    @Body() dto: AdminBulkAssignPlanDto,
  ) {
    return this.usersService.bulkAssignPlan(req.user.sub, dto);
  }

  @Post('admin/assign-plan/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Assign a subscription plan to user (Admin only)' })
  async assignPlan(
    @Request() req: any, 
    @Param('userId') userId: string,
    @Body() dto: AdminAssignPlanDto,
  ) {
    return this.usersService.assignPlan(req.user.sub, userId, dto);
  }

  @Post('admin/set-email-verified/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Set email verification status (Admin only)' })
  async setEmailVerified(
    @Request() req: any, 
    @Param('userId') userId: string,
    @Body() dto: AdminSetEmailVerifiedDto,
  ) {
    return this.usersService.setEmailVerified(req.user.sub, userId, dto);
  }

  @Post('admin/promote/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Promote user to admin (Super Admin only)' })
  async promoteToAdmin(@Request() req: any, @Param('userId') userId: string) {
    return this.usersService.promoteToAdmin(req.user.sub, userId);
  }

  @Post('admin/demote/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Demote admin to user (Super Admin only)' })
  async demoteFromAdmin(@Request() req: any, @Param('userId') userId: string) {
    return this.usersService.demoteFromAdmin(req.user.sub, userId);
  }
}

