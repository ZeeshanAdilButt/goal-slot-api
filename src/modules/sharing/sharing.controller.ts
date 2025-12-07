import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SharingService } from './sharing.service';
import { InviteUserDto } from './dto/sharing.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('sharing')
@Controller('sharing')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SharingController {
  constructor(private sharingService: SharingService) {}

  @Post('invite')
  @ApiOperation({ summary: 'Invite a user to access your data' })
  async inviteUser(@Request() req: any, @Body() dto: InviteUserDto) {
    return this.sharingService.inviteUser(req.user.sub, dto);
  }

  @Post('accept')
  @ApiOperation({ summary: 'Accept a share invitation' })
  async acceptInvitation(@Request() req: any, @Query('token') token: string) {
    return this.sharingService.acceptInvitation(req.user.sub, token);
  }

  @Get()
  @ApiOperation({ summary: 'Get all shared access (shared with me and by me)' })
  async getMySharedAccess(@Request() req: any) {
    return this.sharingService.getMySharedAccess(req.user.sub);
  }

  @Get('my-shares')
  @ApiOperation({ summary: 'Get shares I created' })
  async getMyShares(@Request() req: any) {
    return this.sharingService.getMyShares(req.user.sub);
  }

  @Get('pending-invites')
  @ApiOperation({ summary: 'Get pending invites for me' })
  async getPendingInvites(@Request() req: any) {
    return this.sharingService.getPendingInvites(req.user.sub);
  }

  @Post('accept/:inviteId')
  @ApiOperation({ summary: 'Accept a pending invite' })
  async acceptInvite(@Request() req: any, @Param('inviteId') inviteId: string) {
    return this.sharingService.acceptInvite(req.user.sub, inviteId);
  }

  @Post('decline/:inviteId')
  @ApiOperation({ summary: 'Decline a pending invite' })
  async declineInvite(@Request() req: any, @Param('inviteId') inviteId: string) {
    return this.sharingService.declineInvite(req.user.sub, inviteId);
  }

  @Get('user/:ownerId')
  @ApiOperation({ summary: 'Get shared user data' })
  async getSharedUserData(@Request() req: any, @Param('ownerId') ownerId: string) {
    return this.sharingService.getSharedUserData(req.user.sub, ownerId);
  }

  @Delete('revoke/:shareId')
  @ApiOperation({ summary: 'Revoke access you granted' })
  async revokeAccess(@Request() req: any, @Param('shareId') shareId: string) {
    return this.sharingService.revokeAccess(req.user.sub, shareId);
  }

  @Delete('remove/:shareId')
  @ApiOperation({ summary: 'Remove access granted to you' })
  async removeMyAccess(@Request() req: any, @Param('shareId') shareId: string) {
    return this.sharingService.removeMyAccess(req.user.sub, shareId);
  }
}
