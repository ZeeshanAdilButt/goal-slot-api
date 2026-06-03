import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WhiteboardsService } from './whiteboards.service';
import { CreateWhiteboardDto, UpdateWhiteboardDto } from './dto/whiteboards.dto';
import { InviteWhiteboardShareDto } from './dto/whiteboard-share.dto';

@ApiTags('whiteboards')
@Controller('whiteboards')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WhiteboardsController {
  constructor(private readonly whiteboardsService: WhiteboardsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all whiteboards owned by the user' })
  async findAll(@Request() req: any) {
    return this.whiteboardsService.findAll(req.user.sub);
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'List whiteboards shared with the current user' })
  async sharedWithMe(@Request() req: any) {
    return this.whiteboardsService.findSharedWithMe(req.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific whiteboard (owner or share recipient)' })
  async findOne(@Param('id') id: string, @Request() req: any) {
    return this.whiteboardsService.findOneAccessible(id, req.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new whiteboard' })
  async create(@Body() dto: CreateWhiteboardDto, @Request() req: any) {
    return this.whiteboardsService.create(req.user.sub, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a whiteboard' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWhiteboardDto,
    @Request() req: any,
  ) {
    return this.whiteboardsService.update(id, req.user.sub, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a whiteboard' })
  async delete(@Param('id') id: string, @Request() req: any) {
    return this.whiteboardsService.delete(id, req.user.sub);
  }

  // Sharing 

  @Get(':id/share')
  @ApiOperation({ summary: 'Get the share state for a whiteboard (owner only)' })
  async getShareState(@Param('id') id: string, @Request() req: any) {
    return this.whiteboardsService.getShareState(id, req.user.sub);
  }

  @Post(':id/share/public-link')
  @ApiOperation({ summary: 'Enable a public link for a whiteboard' })
  async enablePublicLink(@Param('id') id: string, @Request() req: any) {
    return this.whiteboardsService.enablePublicLink(id, req.user.sub);
  }

  @Delete(':id/share/public-link')
  @ApiOperation({ summary: 'Revoke the public link for a whiteboard' })
  async revokePublicLink(@Param('id') id: string, @Request() req: any) {
    return this.whiteboardsService.revokePublicLink(id, req.user.sub);
  }

  @Post(':id/share/invite')
  @ApiOperation({ summary: 'Invite a user by email to view this whiteboard' })
  async invite(
    @Param('id') id: string,
    @Body() dto: InviteWhiteboardShareDto,
    @Request() req: any,
  ) {
    return this.whiteboardsService.invite(id, req.user.sub, dto.email);
  }

  @Delete(':id/share/invite/:shareId')
  @ApiOperation({ summary: 'Revoke an email share invite' })
  async revokeInvite(
    @Param('id') id: string,
    @Param('shareId') shareId: string,
    @Request() req: any,
  ) {
    return this.whiteboardsService.revokeInvite(id, req.user.sub, shareId);
  }
}