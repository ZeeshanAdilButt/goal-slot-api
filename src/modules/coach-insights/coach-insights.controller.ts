import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CoachInsightsService } from './coach-insights.service';
import { ListInsightsDto } from './dto/list-insights.dto';
import { UpdateInsightStatusDto } from './dto/update-insight-status.dto';

@ApiTags('coach-insights')
@Controller('coach/insights')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachInsightsController {
  constructor(private readonly insightsService: CoachInsightsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List coach insights for the user (default ACTIVE = PROPOSED+ACCEPTED+DOING)',
  })
  async list(@Request() req: any, @Query() query: ListInsightsDto) {
    return this.insightsService.list(req.user.sub, query.status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single coach insight by id' })
  async getOne(@Request() req: any, @Param('id') id: string) {
    return this.insightsService.findOne(req.user.sub, id);
  }

  @Post(':id/status')
  @ApiOperation({ summary: 'Update an insight status (stamps the matching timestamp)' })
  async updateStatus(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateInsightStatusDto,
  ) {
    return this.insightsService.updateStatus(
      req.user.sub,
      id,
      dto.status,
      dto.note,
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Delete an insight (only PROPOSED and DISMISSED statuses are deletable)',
  })
  async remove(@Request() req: any, @Param('id') id: string) {
    return this.insightsService.remove(req.user.sub, id);
  }
}
