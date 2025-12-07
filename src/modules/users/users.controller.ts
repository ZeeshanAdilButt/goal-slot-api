import { Controller, Get, Put, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto, CreateInternalUserDto } from './dto/users.dto';
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
  @ApiOperation({ summary: 'List all users (Admin only)' })
  async listUsers(
    @Request() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.usersService.listUsers(req.user.sub, page, limit);
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

  @Post('admin/promote/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Promote user to admin (Super Admin only)' })
  async promoteToAdmin(@Request() req: any, @Param('userId') userId: string) {
    return this.usersService.promoteToAdmin(req.user.sub, userId);
  }
}
