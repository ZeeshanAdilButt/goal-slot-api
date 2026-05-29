import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CoachJournalService } from './coach-journal.service';
import { ListJournalEntriesDto } from './dto/list-journal-entries.dto';
import { UpdateJournalContentDto } from './dto/update-content.dto';
import { UpdateJournalMoodDto } from './dto/update-mood.dto';
import { UpsertJournalEntryDto } from './dto/upsert-journal-entry.dto';

const DATE_PARAM = '\\d{4}-\\d{2}-\\d{2}';

@ApiTags('coach-journal')
@Controller('coach/journal/entries')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachJournalController {
  constructor(private readonly journalService: CoachJournalService) {}

  @Get()
  @ApiOperation({ summary: 'List journal entries for the user (default last 60 days)' })
  async list(@Request() req: any, @Query() query: ListJournalEntriesDto) {
    return this.journalService.list(req.user.sub, query);
  }

  @Get(`:date(${DATE_PARAM})`)
  @ApiOperation({ summary: 'Get a single journal entry by date' })
  async getOne(@Request() req: any, @Param('date') date: string) {
    return this.journalService.getOne(req.user.sub, date);
  }

  @Post()
  @ApiOperation({ summary: 'Upsert a journal entry on [userId, date]' })
  async upsert(@Request() req: any, @Body() dto: UpsertJournalEntryDto) {
    return this.journalService.upsert(req.user.sub, dto);
  }

  @Put(`:date(${DATE_PARAM})/content`)
  @ApiOperation({ summary: 'Set the HTML content of an entry (upsert if missing)' })
  async updateContent(
    @Request() req: any,
    @Param('date') date: string,
    @Body() dto: UpdateJournalContentDto,
  ) {
    return this.journalService.updateContent(req.user.sub, date, dto);
  }

  @Put(`:date(${DATE_PARAM})/mood`)
  @ApiOperation({ summary: 'Set the mood/energy of an entry (upsert if missing)' })
  async updateMood(
    @Request() req: any,
    @Param('date') date: string,
    @Body() dto: UpdateJournalMoodDto,
  ) {
    return this.journalService.updateMood(req.user.sub, date, dto);
  }

  @Delete(`:date(${DATE_PARAM})`)
  @ApiOperation({ summary: 'Delete an entry by date (idempotent)' })
  async delete(@Request() req: any, @Param('date') date: string) {
    return this.journalService.delete(req.user.sub, date);
  }
}
