import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { LabelsService } from './labels.service';
import { CreateLabelDto, UpdateLabelDto, AssignLabelsDto } from './dto/labels.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('labels')
@Controller('labels')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class LabelsController {
  constructor(private labelsService: LabelsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new label' })
  async create(@Request() req: any, @Body() dto: CreateLabelDto) {
    return this.labelsService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all labels for user' })
  async findAll(@Request() req: any) {
    return this.labelsService.findAll(req.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific label' })
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.labelsService.findOne(req.user.sub, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a label' })
  async update(@Request() req: any, @Param('id') id: string, @Body() dto: UpdateLabelDto) {
    return this.labelsService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a label' })
  async delete(@Request() req: any, @Param('id') id: string) {
    return this.labelsService.delete(req.user.sub, id);
  }

  @Put('reorder/bulk')
  @ApiOperation({ summary: 'Reorder labels' })
  async reorder(@Request() req: any, @Body() body: { labelIds: string[] }) {
    return this.labelsService.reorder(req.user.sub, body.labelIds);
  }

  @Post('goals/:goalId/assign')
  @ApiOperation({ summary: 'Assign labels to a goal' })
  async assignToGoal(
    @Request() req: any,
    @Param('goalId') goalId: string,
    @Body() dto: AssignLabelsDto,
  ) {
    return this.labelsService.assignLabelsToGoal(req.user.sub, goalId, dto.labelIds);
  }

  @Get('goals/:goalId')
  @ApiOperation({ summary: 'Get labels for a specific goal' })
  async getLabelsForGoal(@Request() req: any, @Param('goalId') goalId: string) {
    return this.labelsService.getLabelsForGoal(req.user.sub, goalId);
  }
}
