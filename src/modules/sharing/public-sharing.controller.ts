import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SharingService } from './sharing.service';

@ApiTags('public-sharing')
@Controller('public/share')
export class PublicSharingController {
  constructor(private sharingService: SharingService) {}

  @Get('accept')
  @ApiOperation({ summary: 'Accept email-based invitation without authentication' })
  @ApiQuery({ name: 'token', required: true, description: 'Invitation token from email' })
  async acceptEmailInvitation(@Query('token') token: string) {
    return this.sharingService.acceptEmailInvitationPublic(token);
  }

  @Get('view/:token')
  @ApiOperation({ summary: 'View shared data via public token (no auth required)' })
  async viewSharedData(@Param('token') token: string) {
    return this.sharingService.getPublicSharedData(token);
  }

  @Get('view/:token/time-entries')
  @ApiOperation({ summary: 'Get time entries for a publicly shared user' })
  @ApiQuery({ name: 'startDate', required: true, example: '2025-12-01' })
  @ApiQuery({ name: 'endDate', required: true, example: '2025-12-31' })
  async getPublicSharedTimeEntries(
    @Param('token') token: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.sharingService.getPublicSharedTimeEntries(token, startDate, endDate);
  }

  @Get('view/:token/goals')
  @ApiOperation({ summary: 'Get goals for a publicly shared user' })
  async getPublicSharedGoals(@Param('token') token: string) {
    return this.sharingService.getPublicSharedGoals(token);
  }
}
