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
import { NotesService } from './notes.service';
import { CreateNoteDto, UpdateNoteDto, ReorderNotesDto } from './dto/notes.dto';
import { InviteNoteShareDto } from './dto/note-share.dto';

@ApiTags('notes')
@Controller('notes')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all notes owned by the user' })
  async findAll(@Request() req: any) {
    return this.notesService.findAll(req.user.sub);
  }

  // Notes shared with the current user, plus owner metadata so the
  // sidebar can group them by who shared them.
  @Get('shared-with-me')
  @ApiOperation({ summary: 'List notes shared with the current user' })
  async sharedWithMe(@Request() req: any) {
    return this.notesService.findSharedWithMe(req.user.sub);
  }

  // Owner OR share recipient can read; share-recipient responses carry
  // readOnly: true so the editor disables saves.
  @Get(':id')
  @ApiOperation({ summary: 'Get a specific note (owner or share recipient)' })
  async findOne(@Param('id') id: string, @Request() req: any) {
    return this.notesService.findOneAccessible(id, req.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new note' })
  async create(@Body() dto: CreateNoteDto, @Request() req: any) {
    return this.notesService.create(req.user.sub, dto);
  }

  @Put('reorder')
  @ApiOperation({ summary: 'Reorder notes' })
  async reorder(@Body() items: ReorderNotesDto[], @Request() req: any) {
    return this.notesService.reorder(req.user.sub, items);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a note' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateNoteDto,
    @Request() req: any,
  ) {
    return this.notesService.update(id, req.user.sub, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a note' })
  async delete(@Param('id') id: string, @Request() req: any) {
    return this.notesService.delete(id, req.user.sub);
  }

  // --- Sharing ---

  @Get(':id/share')
  @ApiOperation({ summary: 'Get the share state for a note (owner only)' })
  async getShareState(@Param('id') id: string, @Request() req: any) {
    return this.notesService.getShareState(id, req.user.sub);
  }

  @Post(':id/share/public-link')
  @ApiOperation({ summary: 'Enable a public link for a note' })
  async enablePublicLink(@Param('id') id: string, @Request() req: any) {
    return this.notesService.enablePublicLink(id, req.user.sub);
  }

  @Delete(':id/share/public-link')
  @ApiOperation({ summary: 'Revoke the public link for a note' })
  async revokePublicLink(@Param('id') id: string, @Request() req: any) {
    return this.notesService.revokePublicLink(id, req.user.sub);
  }

  @Post(':id/share/invite')
  @ApiOperation({ summary: 'Invite a user by email to view this note' })
  async invite(
    @Param('id') id: string,
    @Body() dto: InviteNoteShareDto,
    @Request() req: any,
  ) {
    return this.notesService.invite(id, req.user.sub, dto.email);
  }

  @Delete(':id/share/invite/:shareId')
  @ApiOperation({ summary: 'Revoke an email share invite' })
  async revokeInvite(
    @Param('id') id: string,
    @Param('shareId') shareId: string,
    @Request() req: any,
  ) {
    return this.notesService.revokeInvite(id, req.user.sub, shareId);
  }
}
