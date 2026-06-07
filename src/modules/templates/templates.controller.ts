import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ImportTemplateDto } from './dto/import-template.dto';
import { TemplatesService } from './templates.service';

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  // Browse endpoint. Returns summaries only; the heavy schedule and tasks
  // sections live on the detail endpoint.
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List approved community templates' })
  list() {
    return this.templates.list();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get one template with full schedule, goals, tasks' })
  getOne(@Param('id') id: string) {
    return this.templates.getOne(id);
  }

  @Post(':id/import')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Import a template into the current user account. Each section is opt-in.',
  })
  import(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: ImportTemplateDto,
  ) {
    return this.templates.import(req.user.sub, id, {
      schedule: dto.schedule,
      goals: dto.goals,
      tasks: dto.tasks,
      replaceExisting: dto.replaceExisting ?? false,
    });
  }

  // Pull any new tasks the curator has added to a template since the user
  // last imported it. Dedupes by per-task key. Goals and schedule blocks
  // are not touched.
  @Post(':id/sync')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Sync new tasks from a curated template into the current user account',
  })
  sync(@Request() req: any, @Param('id') id: string) {
    return this.templates.syncTasks(req.user.sub, id);
  }
}
