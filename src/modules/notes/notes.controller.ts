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

@ApiTags('notes')
@Controller('notes')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all notes for user' })
  async findAll(@Request() req: any) {
    return this.notesService.findAll(req.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific note' })
  async findOne(@Param('id') id: string, @Request() req: any) {
    return this.notesService.findOne(id, req.user.sub);
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
}
