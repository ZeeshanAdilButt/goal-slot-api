import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { NotesService } from './notes.service';

// Unauthenticated public-link reader. The JwtAuthGuard isn't applied
// at the module or class level here; the token in the URL is the
// capability. Read-only by design; no other note routes live under
// /public/notes.
@ApiTags('public-notes')
@Controller('public/notes')
export class PublicNotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Fetch a publicly shared note by its token' })
  async findByToken(@Param('token') token: string) {
    return this.notesService.findByPublicToken(token);
  }
}
