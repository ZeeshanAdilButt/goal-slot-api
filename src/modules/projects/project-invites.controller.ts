import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';
import { ProjectInvitesService } from './project-invites.service';
import {
  CreateProjectInvitesDto,
  ProjectInviteLinkDto,
} from './dto/projects.dto';

/**
 * Recipient side: anyone signed in who holds a token. Registered before
 * ProjectsController so `/projects/invites/:token` is never read as a
 * project id.
 */
@ApiTags('projects')
@Controller('projects/invites')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProjectInviteTokensController {
  constructor(private invites: ProjectInvitesService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Preview a project invitation' })
  async preview(
    @Request() req: AuthenticatedRequest,
    @Param('token') token: string,
  ) {
    return this.invites.preview(req.user.sub, token);
  }

  @Post(':token/accept')
  @ApiOperation({ summary: 'Accept a project invitation' })
  async accept(
    @Request() req: AuthenticatedRequest,
    @Param('token') token: string,
  ) {
    return this.invites.accept(req.user.sub, token);
  }
}

/** Admin side: invites and the shareable link for one project. */
@ApiTags('projects')
@Controller('projects/:id')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProjectInvitesController {
  constructor(private invites: ProjectInvitesService) {}

  @Post('invites')
  @ApiOperation({ summary: 'Invite people by email (ADMIN)' })
  async create(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateProjectInvitesDto,
  ) {
    return this.invites.createEmailInvites(req.user.sub, id, dto);
  }

  @Get('invites')
  @ApiOperation({ summary: 'Pending email invites (ADMIN)' })
  async list(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.invites.list(req.user.sub, id);
  }

  @Post('invites/:inviteId/resend')
  @ApiOperation({ summary: 'Resend an email invite with a fresh token (ADMIN)' })
  async resend(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.resend(req.user.sub, id, inviteId);
  }

  @Delete('invites/:inviteId')
  @ApiOperation({ summary: 'Revoke an invite (ADMIN)' })
  async revoke(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.revoke(req.user.sub, id, inviteId);
  }

  @Post('invite-link')
  @ApiOperation({ summary: 'Create or return the shareable invite link (ADMIN)' })
  async getOrCreateLink(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ProjectInviteLinkDto,
  ) {
    return this.invites.getOrCreateLink(req.user.sub, id, dto ?? {});
  }

  @Delete('invite-link')
  @ApiOperation({ summary: 'Revoke the shareable invite link (ADMIN)' })
  async revokeLink(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.invites.revokeLink(req.user.sub, id);
  }
}
