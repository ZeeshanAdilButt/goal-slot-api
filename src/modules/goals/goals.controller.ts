import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { GoalsService } from './goals.service';
import { CreateGoalDto, UpdateGoalDto } from './dto/goals.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GoalStatus } from '@prisma/client';

@ApiTags('goals')
@Controller('goals')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class GoalsController {
  constructor(private goalsService: GoalsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new goal' })
  async create(@Request() req: any, @Body() dto: CreateGoalDto) {
    return this.goalsService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all goals' })
  @ApiQuery({ name: 'status', enum: GoalStatus, required: false })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by single category value' })
  @ApiQuery({ name: 'categories', required: false, description: 'Comma-separated category values to filter by' })
  @ApiQuery({ name: 'labelIds', required: false, description: 'Comma-separated label IDs to filter by' })
  async findAll(
    @Request() req: any,
    @Query('status') status?: GoalStatus,
    @Query('category') category?: string,
    @Query('categories') categories?: string,
    @Query('labelIds') labelIds?: string,
  ) {
    const parsedLabelIds = labelIds ? labelIds.split(',').filter(Boolean) : undefined;
    const parsedCategories = categories ? categories.split(',').filter(Boolean) : undefined;
    return this.goalsService.findAll(req.user.sub, { status, category, categories: parsedCategories, labelIds: parsedLabelIds });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get goals statistics' })
  async getStats(@Request() req: any) {
    return this.goalsService.getStats(req.user.sub);
  }

  @Put('reorder')
  @ApiOperation({ summary: 'Reorder goals' })
  async reorder(@Request() req: any, @Body() body: { ids: string[] }) {
    return this.goalsService.reorder(req.user.sub, body.ids);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific goal' })
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.goalsService.findOne(req.user.sub, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a goal' })
  async update(@Request() req: any, @Param('id') id: string, @Body() dto: UpdateGoalDto) {
    return this.goalsService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a goal' })
  async delete(@Request() req: any, @Param('id') id: string) {
    return this.goalsService.delete(req.user.sub, id);
  }
}
