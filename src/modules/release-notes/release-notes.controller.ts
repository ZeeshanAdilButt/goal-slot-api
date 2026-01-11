import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Request, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ReleaseNotesService } from './release-notes.service'
import { CreateReleaseNoteDto } from './dto/create-release-note.dto'
import { UpdateReleaseNoteDto } from './dto/update-release-note.dto'

@ApiTags('release-notes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('release-notes')
export class ReleaseNotesController {
  constructor(private releaseNotesService: ReleaseNotesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new release note (admin only)' })
  async create(@Body() dto: CreateReleaseNoteDto, @Request() req: any) {
    return this.releaseNotesService.create(dto, req.user.role)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a release note (admin only)' })
  async update(@Param('id') id: string, @Body() dto: UpdateReleaseNoteDto, @Request() req: any) {
    return this.releaseNotesService.update(id, dto, req.user.role)
  }

  @Get()
  @ApiOperation({ summary: 'Get all release notes' })
  async findAll() {
    return this.releaseNotesService.findAll()
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a release note (admin only)' })
  async delete(@Param('id') id: string, @Request() req: any) {
    return this.releaseNotesService.delete(id, req.user.role)
  }

  @Get('latest')
  @ApiOperation({ summary: 'Get the latest release note and seen status for the current user' })
  async latest(@Request() req: any) {
    return this.releaseNotesService.latest(req.user.sub)
  }

  @Get('unseen')
  @ApiOperation({ summary: 'Get all unseen release notes for the current user' })
  async findUnseen(@Request() req: any) {
    return this.releaseNotesService.findUnseen(req.user.sub)
  }

  @Patch(':id/seen')
  @ApiOperation({ summary: 'Mark a release note as seen by the current user' })
  async markSeen(@Param('id') id: string, @Request() req: any) {
    return this.releaseNotesService.markSeen(id, req.user.sub)
  }
}
